import os
import json
from datetime import datetime
from flask import Flask, render_template, request, jsonify, redirect, url_for, flash
from flask_sqlalchemy import SQLAlchemy
from flask_login import (
    LoginManager,
    UserMixin,
    login_user,
    logout_user,
    login_required,
    current_user,
)
from werkzeug.security import generate_password_hash, check_password_hash
from google import genai
from dotenv import load_dotenv

# .envの読み込み
load_dotenv()

app = Flask(__name__)

# 各種設定（環境変数から読み込み、なければデフォルト値）
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "default-fallback-key-for-local")
# SQLiteデータベースの保存先を指定。instance/database.dbを指定
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///database.db"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

# 各種ライブラリの初期化
db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = "login"  # 未ログイン時の転送先

# Geminiクライアントの初期化
client = genai.Client()


# ----------------------------------------------------
# データベースのモデル（テーブル）定義
# ----------------------------------------------------
class User(UserMixin, db.Model):
    __tablename__ = "users"
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(50), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    # リレーションシップ（ユーザーが削除されたら議事録も削除）
    minutes = db.relationship(
        "Minute", backref="author", lazy=True, cascade="all, delete-orphan"
    )


class Minute(db.Model):
    __tablename__ = "minutes"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    title = db.Column(db.String(100), nullable=False)
    transcript = db.Column(db.Text, nullable=False)
    summary = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))


# ----------------------------------------------------
# ルーティング（認証関連）
# ----------------------------------------------------
@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username")
        password = request.form.get("password")

        user = User.query.filter_by(username=username).first()
        if user and check_password_hash(user.password_hash, password):
            login_user(user)
            return redirect(url_for("index"))

        flash("ユーザー名またはパスワードが間違っています。")
    return render_template("login.html")


@app.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for("login"))


# ----------------------------------------------------
# ルーティング（メイン機能：ログイン必須）
# ----------------------------------------------------
@app.route("/")
@login_required
def index():
    # ログイン中のユーザーの過去の議事録（履歴）を最新順に取得
    user_minutes = (
        Minute.query.filter_by(user_id=current_user.id)
        .order_by(Minute.created_at.desc())
        .all()
    )
    return render_template("index.html", minutes=user_minutes)


@app.route("/api/summarize", methods=["POST"])
@login_required
def summarize():
    data = request.json
    text_content = data.get("text", "")
    title = data.get("title", "定例ミーティング")

    if not text_content:
        return jsonify({"error": "テキストが空です"}), 400

    try:
        # 最新のGemini Flashモデルを使用して議事録を生成
        response = client.models.generate_content(
            model="gemini-2.5-flash",  # 最新の推奨安定版モデル
            contents=f"会議タイトル: {title}\n\n発言内容:\n{text_content}",
            config=genai.types.GenerateContentConfig(
                system_instruction="あなたは優秀な書記です。提供された対話テキストから、決定事項、重要なポイント、ネクストアクションを整理した綺麗な議事録を作成してください。",
                temperature=0.5,
            ),
        )
        summary = response.text

        # データベースに履歴を保存
        new_minute = Minute(
            user_id=current_user.id,
            title=title,
            transcript=text_content,
            summary=summary,
        )
        db.session.add(new_minute)
        db.session.commit()

        return jsonify({"summary": summary})

    except Exception as e:
        db.session.rollback()
        return jsonify({"error": str(e)}), 500


# ----------------------------------------------------
#  ルーティング（議事録の削除：ログイン必須）
# ----------------------------------------------------
@app.route("/api/minutes/<int:minute_id>", methods=["DELETE"])
@login_required
def delete_minute(minute_id):
    # 削除対象の議事録をIDで取得（なければ404エラー）
    minute = Minute.query.get_or_404(minute_id)

    # セキュリティ対策：他人の議事録を勝手に削除できないようにチェック
    if minute.user_id != current_user.id:
        return jsonify({"error": "この議事録の削除権限がありません"}), 403

    try:
        db.session.delete(minute)
        db.session.commit()
        return jsonify({"message": "削除に成功しました"})
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": str(e)}), 500


# ----------------------------------------------------
#  起動処理（データベースの自動生成とデモユーザー作成）
# ----------------------------------------------------
with app.app_context():
    db.create_all()  # instance/database.dbの自動生成

    # ゲストがすぐにログインできるようにデモユーザーを自動作成
    if not User.query.filter_by(username="admin").first():
        demo_user = User(
            username="admin", password_hash=generate_password_hash("password123")
        )
        db.session.add(demo_user)
        db.session.commit()


# ----------------------------------------------------
#  ルーティング（AIアドバイザーチャット：ログイン必須）
# ----------------------------------------------------
@app.route('/api/chat', methods=['POST'])
@login_required
def ai_chat():
    data = request.json
    user_message = data.get('message', '')
    transcript = data.get('transcript', '')
    meeting_goal = data.get('goal', '一般的なビジネス交渉')
    
    # 💡 新しくフロントから送られてくる情報をキャッチ
    meeting_type = data.get('type', '対外打ち合わせ')
    participants = data.get('participants', '関係者一同')

    # 💡 完璧な前提条件（文脈）を構築してGeminiに送る
    prompt = (
        f"【会議の基本前提】\n"
        f"・会議の種類: {meeting_type}\n"
        f"・参加者構成: {participants}\n"
        f"・この会議の目的・ゴール: {meeting_goal}\n\n"
        f"【現在のリアルタイム文字起こしログ】\n{transcript}\n\n"
    )
    
    if user_message:
        prompt += f"【後輩からの個別の質問】\n{user_message}"
    else:
        prompt += "【指示】上記の会議の前提と参加者の関係性を踏まえ、現在の進行状況に致命的なリスクや確認漏れがないか、ベテランの視点で監視・診断してください。"
        
    try:
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=prompt,
            config=genai.types.GenerateContentConfig(
                system_instruction=(
                    "あなたは交渉やマネジメントについて経験豊富な『ベテランの先輩』です。"
                    "経験の浅い後輩が、会社を代表して他社や団体と交渉を行っています。"
                    "【ルール】"
                    "1. 問題がありそうな方向へ会議が進行したり、通常であれば確認すべき事柄（期間、コスト、条件、持ち帰り判断など）が欠如している場合、または【会議の目的】からズレている場合に限り、アドバイスを出力してください。"
                    "2. 出力する際は、必ず『【タイトル】概要文』の形式を守り、極力端的に1〜2行で記述してください。（例：【期間やコストの確認が不足】相手の提示条件に対して、具体的な金額と納期の握りが漏れています。致命的な内容です。）"
                    "3. 現在の会議進行に問題がなく、順調である場合は、余計なアドバイスはせず『現在、特に問題はありません。このまま目的の達成に向けて交渉を続けてください。』とだけ返してください。"
                ),
                temperature=0.3, # 💡 厳格な診断のために温度を低めに設定
            ),
        )
        return jsonify({'reply': response.text})

    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ----------------------------------------------------
#  ルーティング（AI発言区切り処理：ログイン必須）
# ----------------------------------------------------
@app.route('/api/segment', methods=['POST'])
@login_required
def segment():
    data = request.json
    text = data.get('text', '').strip()

    if not text:
        return jsonify({"completed": [], "incomplete": ""})

    try:
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=f"以下は会議中の音声認識テキストです。\n\n{text}",
            config=genai.types.GenerateContentConfig(
                system_instruction=(
                    "あなたは会議の文字起こしを整理するアシスタントです。"
                    "渡されたテキストを意味の通る発言単位に区切り、以下のJSON形式のみで返してください。"
                    "マークダウンのコードブロックや余計な文字は一切含めないでください。"
                    '{"completed": ["完結した発言1", "完結した発言2"]}'
                    "【判定ルール】"
                    "- 句読点がなくても内容・文脈が変わっていれば別の発言として区切る"
                    "- 報告・質問・回答・相槌はそれぞれ別の発言として扱う"
                    "- 渡されたテキストは無音を検知して区切ったものなので、すべて完結した発言として扱う"
                    "- completedは必ず1件以上返す"
                ),
                temperature=0.1,
            ),
        )

        raw = response.text.strip().replace('```json', '').replace('```', '').strip()
        result = json.loads(raw)
        completed = result.get('completed', [])
        return jsonify({"completed": completed})

    except Exception as e:
        # パース失敗時はテキスト全体を1件の完結発言として返す
        return jsonify({"completed": [text]})


if __name__ == "__main__":
    app.run(debug=True)
