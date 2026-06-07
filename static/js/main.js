const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isAdviceModeActive = false;

// 状態管理
let rawBuffer = '';        // isFinalで確定したテキストの蓄積バッファ
let confirmedLines = [];   // AIが完結と判定した発言の配列
let isSegmenting = false;  // API多重呼び出し防止フラグ
let silenceTimer = null;   // 無音タイマー
const SILENCE_MS = 2000;   // 無音判定の閾値（ミリ秒）
let pendingSegmentText = ''; // AI解析中に消えないよう保持する一時テキスト

// UI要素の一括取得
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusBadge = document.getElementById('statusBadge');
const transcriptArea = document.getElementById('transcriptArea');
const generateBtn = document.getElementById('generateBtn');
const summaryResult = document.getElementById('summaryResult');
const sessionTitle = document.getElementById('sessionTitle');
const meetingGoal = document.getElementById('meetingGoal');
const meetingType = document.getElementById('meetingType');
const meetingParticipants = document.getElementById('meetingParticipants');
const toggleAdviceBtn = document.getElementById('toggleAdviceBtn');
const manualCheckBtn = document.getElementById('manualCheckBtn');
const chatBox = document.getElementById('chatBox');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');

// アドバイスモード常時切り替えトグル
toggleAdviceBtn.addEventListener('click', () => {
    isAdviceModeActive = !isAdviceModeActive;
    if (isAdviceModeActive) {
        toggleAdviceBtn.textContent = '?? ON';
        toggleAdviceBtn.className = 'bg-emerald-500 text-white text-xs font-bold py-1.5 px-3 rounded transition shadow-xs cursor-pointer select-none';
        manualCheckBtn.classList.remove('hidden');
        appendChatMessage('ai', '????? 先輩:「アドバイスモードを有効にしたな。会議の前提に沿って見守っているぞ。」');
    } else {
        toggleAdviceBtn.textContent = '?? OFF';
        toggleAdviceBtn.className = 'bg-gray-400 text-white text-xs font-bold py-1.5 px-3 rounded transition shadow-xs cursor-pointer select-none';
        manualCheckBtn.classList.add('hidden');
    }
});

// 音声認識（Web Speech API）初期化
if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = true;       // 連続録音を維持
    recognition.interimResults = true;   // 話し途中の言葉もリアルタイム表示
    recognition.lang = 'ja-JP';

    recognition.onresult = (event) => {
        let interimTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
            const result = event.results[i];
            if (result) {
	            if (result.isFinal) {
	                const finalText = result[0].transcript.trim();
	                if (finalText) rawBuffer += finalText;
	            } else {
	                interimTranscript += result[0].transcript;
	            }
	        }
        }

        // 発話を検知したので無音タイマーをリセット
        resetSilenceTimer();

        // 確定済み行 + 現在入力中テキストをリアルタイム表示
        renderTranscript(interimTranscript);
    };

    recognition.onerror = (event) => {
        console.error("音声認識エラー:", event.error);
        //  画面のバッジにエラー原因（aborted, network, not-allowed等）を直接出して見える化します
        statusBadge.textContent = 'エラー: ' + event.error;
        statusBadge.className = 'text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-sm';
    };

    //  途中で勝手に切れてしまう対策（認識が終了したら自動で再起動する）
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
    // 最初にはじめるときに状態をリセット
    transcriptArea.value = '';
    rawBuffer = '';
    confirmedLines = [];
    isSegmenting = false;
    clearTimeout(silenceTimer);
    silenceTimer = null;

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
    // タイマーを止めて残バッファを最終処理
    clearTimeout(silenceTimer);
    silenceTimer = null;
    recognition.stop();
    stopBtn.classList.add('hidden');
    startBtn.classList.remove('hidden');
    // 残バッファがあれば最終セグメント処理
    if (rawBuffer.trim()) {
        runSegment().then(() => {
            statusBadge.textContent = '停止中';
            statusBadge.className = 'text-[10px] bg-gray-200 text-gray-600 px-2 py-0.5 rounded-sm';
            if (isAdviceModeActive && getFullTranscript()) triggerAiAdvice();
        });
    } else {
        statusBadge.textContent = '停止中';
        statusBadge.className = 'text-[10px] bg-gray-200 text-gray-600 px-2 py-0.5 rounded-sm';
        if (isAdviceModeActive && getFullTranscript()) triggerAiAdvice();
    }
});

// -------------------------------------------------------
// 無音検知・AI区切り処理
// -------------------------------------------------------

// 無音タイマーをリセット（発話/interim検知のたびに呼ぶ）
function resetSilenceTimer() {
    clearTimeout(silenceTimer);
    if (!rawBuffer.trim()) return; // バッファが空なら待機不要
    silenceTimer = setTimeout(() => {
        // SILENCE_MS 間 onresult が来なければ発言完結と判断
        runSegment();
    }, SILENCE_MS);
}

// AIによる発言区切り処理
async function runSegment() {
    const input = rawBuffer.trim();
    rawBuffer = '';
    if (!input || isSegmenting) return;

    isSegmenting = true;
    statusBadge.textContent = '録音中... (AI解析中)';

    // API待機中もinputをpendingとして保持しておく
    // renderTranscriptが何度呼ばれても消えなくなる
    pendingSegmentText = input;
    renderTranscript();

    try {
        const response = await fetch('/api/segment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: input })
        });
        const data = await response.json();

        if (response.ok && data.completed && data.completed.length > 0) {
            confirmedLines.push(...data.completed);
        }
    } catch (e) {
        // 通信失敗時はバッファを戻してロスを防ぐ
        rawBuffer = input + rawBuffer;
        console.warn('segment error:', e);
    } finally {
        pendingSegmentText = '';
        isSegmenting = false;
        renderTranscript();
        if (statusBadge.textContent.includes('AI解析中')) {
            statusBadge.textContent = '録音中...';
        }
    }
}

// transcriptAreaの表示を更新（確定済み行 + 入力中テキスト）
function renderTranscript(interimText = '') {
    const confirmed = confirmedLines.join('\n');
    // AI解析待機中はpendingSegmentTextを挟んで表示を維持する
    const parts = [confirmed, pendingSegmentText, interimText].filter(Boolean);
    transcriptArea.value = parts.join('\n');
    transcriptArea.scrollTop = transcriptArea.scrollHeight;
}

// 確定済み + バッファ中のテキストを結合して返す
function getFullTranscript() {
    return [...confirmedLines, rawBuffer].filter(Boolean).join('\n');
}

// 先輩への進行チェック通信処理
async function triggerAiAdvice() {
    const transcript = getFullTranscript();
    if (!transcript) return;

    manualCheckBtn.textContent = '分析中...';
    manualCheckBtn.disabled = true;
    const loadId = appendChatMessage('ai', '（先輩が議論ログを分析中...）');

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: '',
                transcript: transcript,
                goal: meetingGoal.value.trim() || '一般的なビジネス交渉',
                type: meetingType.value,
                participants: meetingParticipants.value.trim() || '未入力'
            })
        });
        const data = await response.json();
        document.getElementById(loadId).remove();
        if (response.ok) appendChatMessage('ai', '????? 先輩からの助言:\n' + data.reply);
        else appendChatMessage('ai', '診断エラー: ' + data.error);
    } catch (error) {
        document.getElementById(loadId).remove();
        appendChatMessage('ai', '通信エラーが発生しました。');
    } finally {
        manualCheckBtn.textContent = '? 今すぐ進行チェック';
        manualCheckBtn.disabled = false;
    }
}

chatSendBtn.addEventListener('click', async () => {
    const message = chatInput.value.trim();
    const transcript = getFullTranscript();

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
            body: JSON.stringify({
                message: message,
                transcript: transcript,
                goal: meetingGoal.value.trim() || '一般的なビジネス交渉',
                type: meetingType.value,
                participants: meetingParticipants.value.trim() || '未入力'
            })
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

// 議事録生成API送信
generateBtn.addEventListener('click', async () => {
    const text = getFullTranscript();
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
            body: JSON.stringify({ text: text, title: sessionTitle.value.trim() || '定例ミーティング' })
        });

        if (response.ok) {
            //summaryResult.textContent = data.summary;
            //summaryResult.classList.remove('hidden');
            window.location.reload();
        } else {
	        const data = await response.json();
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

// 議事録の非同期削除処理
async function deleteMinute(minuteId) {
    if (!confirm('この議事録を完全に削除してもよろしいですか？\n(この操作は取り消せません)')) return;

    try {
        const response = await fetch(`/api/minutes/${minuteId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.ok) {
            // 削除成功時に画面を自動リロードしてリストを最新状態にする
            window.location.reload();
        } else {
	        const data = await response.json();
            alert('エラー: ' + data.error);
        }
    } catch (error) {
        alert('削除通信中にエラーが発生しました。');
    }
}

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
    if (e.target === document.getElementById('historyModal')) {
    	closeHistoryModal();
    }
});
