import os
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
@app.route("/api/chat", methods=["POST"])
@login_required
def ai_chat():
    data = request.json
    user_message = data.get("message", "")  # ユーザーからの質問
    transcript = data.get("transcript", "")  # 現在の文字起こし本文

    if not user_message:
        return jsonify({"error": "メッセージが空です"}), 400

    # 文字起こしが空の場合のコンテキスト分岐処理
    context_info = (
        f"現在の会議の文字起こし内容:\n{transcript}"
        if transcript
        else "現在、会議の文字起こしデータはありません。一般的なビジネスアドバイスを行ってください。"
    )

    try:
        # Gemini 2.5 Flash に文脈付きでアドバイスを要請
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=f"{context_info}\n\nユーザーからの質問: {user_message}",
            config=genai.types.GenerateContentConfig(
                system_instruction=(
                    "あなたは優秀な経営コンサルタント兼ファシリテーターです。"
                    "提供された会議の文字起こし文脈をベースに、客観的な議事分析、"
                    "論点の矛盾点の指摘、あるいは今後の具体的なアクションプランのアドバイスを、"
                    "簡潔かつ建設的に回答してください。"
                ),
                temperature=0.7,
            ),
        )
        return jsonify({"reply": response.text})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(debug=True)
