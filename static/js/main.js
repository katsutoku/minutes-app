const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusBadge = document.getElementById('statusBadge');
const transcriptArea = document.getElementById('transcriptArea');
const generateBtn = document.getElementById('generateBtn');
const summaryResult = document.getElementById('summaryResult');
const sessionTitle = document.getElementById('sessionTitle');

if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = true;       // 連続録音を維持
    recognition.interimResults = true;   // 話し途中の言葉もリアルタイム表示
    recognition.lang = 'ja-JP';

    // これまでの確定した全文章を保持する変数（ループの外に置くか、既存のものと入れ替え）
    let savedFinalText = '';

    recognition.onresult = (event) => {
        let interimTranscript = '';

        // 💡 今回のイベントで発生したテキストを解析
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            const result = event.results[i];
            if (result.isFinal) {
                // 確定したら、保存用の変数に改行付きで追加
                savedFinalText += result[0].transcript + '\n';
            } else {
                // 話し途中のものは一時的な変数に溜める
                interimTranscript += result[0].transcript;
            }
        }

        // 💡 確定済みの文章 ＋ 今まさに話している途中の文字 をリアルタイムに結合して画面に表示！
        transcriptArea.value = savedFinalText + interimTranscript;

        // 常に最新の文字が見えるように最下部へスクロール
        transcriptArea.scrollTop = transcriptArea.scrollHeight;
    };

    recognition.onerror = (event) => {
        console.error("音声認識エラー:", event.error);
        // 💡 画面のバッジにエラー原因（aborted, network, not-allowed等）を直接出して見える化します
        statusBadge.textContent = 'エラー: ' + event.error;
        statusBadge.className = 'text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-sm';
    };

    // 💡 途中で勝手に切れてしまう対策（認識が終了したら自動で再起動する）
    recognition.onend = () => {
        if (statusBadge.textContent.includes('録音中')) {
            recognition.start();
        }
    };
}

// 録音開始ボタン
startBtn.addEventListener('click', () => {
    if (!recognition) {
        alert("お使いのブラウザは音声認識に対応していません。Chrome等をお試しください。");
        return;
    }
    // 最初にはじめるときはエリアをクリア
    transcriptArea.value = '';

    try {
        recognition.start();
        startBtn.classList.add('hidden');
        stopBtn.classList.remove('hidden');
        statusBadge.textContent = '録音中...';
        statusBadge.className = 'text-[10px] bg-red-100 text-red-600 px-2 py-0.5 rounded-sm';
    } catch (e) {
        console.log("すでに起動しています", e);
    }
});

// 録音停止ボタン
stopBtn.addEventListener('click', () => {
    if (!recognition) return;
    statusBadge.textContent = '停止中';
    statusBadge.className = 'text-[10px] bg-gray-200 text-gray-600 px-2 py-0.5 rounded-sm';
    recognition.stop();
    stopBtn.classList.add('hidden');
    startBtn.classList.remove('hidden');
});

// 議事録生成API送信
generateBtn.addEventListener('click', async () => {
    const text = transcriptArea.value.trim();
    const title = sessionTitle.value.trim() || '定例ミーティング';

    if (!text) {
        alert('文字起こしされたテキストがありません。テキストエリアに直接文字入力を入力してテストすることも可能です。');
        return;
    }

    generateBtn.textContent = '生成＆保存中...';
    generateBtn.disabled = true;

    try {
        const response = await fetch('/api/summarize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: text, title: title })
        });

        const data = await response.json();
        if (response.ok) {
            summaryResult.textContent = data.summary;
            summaryResult.classList.remove('hidden');
            window.location.reload();
        } else {
            if (data.error && data.error.includes('503')) {
                alert('【Google AI Studioからのお知らせ】\n現在、無料枠のAIサーバーが世界的に大変混み合っています。大変恐れ入りますが、数十秒ほど時間を空けてから、もう一度「議事録を生成」ボタンを押してください。');
            } else {
                alert('エラー: ' + data.error);
            }
        }
    } catch (error) {
        alert('通信エラーが発生しました。');
    } finally {
        generateBtn.textContent = '議事録を生成して履歴に保存';
        generateBtn.disabled = false;
    }
});

// モーダル表示制御
function showHistoryModal(title, date, summary, transcript) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalDate').textContent = "作成日時: " + date;
    document.getElementById('modalSummary').textContent = summary;
    document.getElementById('modalTranscript').textContent = transcript;
    document.getElementById('historyModal').classList.remove('hidden');
}

function closeHistoryModal() {
    document.getElementById('historyModal').classList.add('hidden');
}

document.getElementById('historyModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('historyModal')) closeHistoryModal();
});

// 議事録の非同期削除処理
async function deleteMinute(minuteId) {
    if (!confirm('この議事録を完全に削除してもよろしいですか？\n(この操作は取り消せません)')) return;

    try {
        const response = await fetch(`/api/minutes/${minuteId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }
        });

        const data = await response.json();
        if (response.ok) {
            // 削除成功時に画面を自動リロードしてリストを最新状態にする
            window.location.reload();
        } else {
            alert('エラー: ' + data.error);
        }
    } catch (error) {
        alert('削除通信中にエラーが発生しました。');
    }
}

//  AIチャット機能の制御ロジック
const chatBox = document.getElementById('chatBox');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');

chatSendBtn.addEventListener('click', async () => {
    const message = chatInput.value.trim();
    const transcript = transcriptArea.value.trim(); //  現在の文字起こしを取得

    if (!message) return;

    // ユーザーのメッセージを画面に即時追加
    appendChatMessage('user', message);
    chatInput.value = ''; // 入力欄をクリア

    // ローディング表示
    const loadingId = appendChatMessage('ai', '思考中...');

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: message, transcript: transcript })
        });

        const data = await response.json();

        // ローディングメッセージを消去
        document.getElementById(loadingId).remove();

        if (response.ok) {
            appendChatMessage('ai', data.reply);
        } else {
            appendChatMessage('ai', 'エラーが発生しました: ' + data.error);
        }
    } catch (error) {
        document.getElementById(loadingId).remove();
        appendChatMessage('ai', '通信エラーが発生しました。');
    }
});

// エンターキーでも送信できるように設定
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') chatSendBtn.click();
});

// チャット画面にメッセージ要素を追加する共通関数
function appendChatMessage(sender, text) {
    // 初回の案内文があれば消去
    if (chatBox.querySelector('.italic')) {
        chatBox.innerHTML = '';
    }

    const msgDiv = document.createElement('div');
    const uniqueId = 'msg-' + Date.now();
    msgDiv.id = uniqueId;
    msgDiv.className = 'p-2 rounded max-w-[85%] text-xs leading-relaxed whitespace-pre-wrap ';

    if (sender === 'user') {
        msgDiv.className += 'bg-blue-100 text-blue-900 ml-auto text-right';
        msgDiv.textContent = text;
    } else {
        msgDiv.className += 'bg-white border border-gray-200 text-gray-800';
        msgDiv.textContent = text;
    }

    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight; // 常に下部へスクロール

    return uniqueId; // ローディング消去用にIDを返す
}

//  アドバイスモード（自動チェック）のボタン制御
const adviceBtn = document.getElementById('adviceBtn');
const meetingGoal = document.getElementById('meetingGoal');

adviceBtn.addEventListener('click', async () => {
    const transcript = transcriptArea.value.trim();
    const goal = meetingGoal.value.trim() || '一般的なビジネス交渉';

    if (!transcript) {
        alert('まだ文字起こしされたテキストがありません。会議が始まってからチェックしてください。');
        return;
    }

    adviceBtn.textContent = '先輩がログを鋭く分析中...';
    adviceBtn.disabled = true;
    appendChatMessage('ai', '（現在の議論のチェックを開始しました...）');

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: '',  // 空文字を渡すことでバックエンド側で自動診断モードを起動
                transcript: transcript,
                goal: goal,
                type: document.getElementById('meetingType').value,
                participants: document.getElementById('meetingParticipants').value || '未入力'
            })
        });

        const data = await response.json();
        if (response.ok) {
            appendChatMessage('ai', '👨‍💼 先輩からの助言:\n' + data.reply);
        } else {
            appendChatMessage('ai', 'チェックエラー: ' + data.error);
        }
    } catch (error) {
        appendChatMessage('ai', '通信エラーが発生しました。');
    } finally {
        adviceBtn.textContent = '🚨 先輩に現在の進行状況をチェックしてもらう（アドバイスモード）';
        adviceBtn.disabled = false;
    }
});
