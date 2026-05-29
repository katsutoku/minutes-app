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

    recognition.onresult = (event) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
            // 💡 安全にテキストデータを抽出する処理に改良
            const result = event.results[i];
            if (!result || !result[0]) continue;

            // 確定・未確定に関わらず、文字データ（transcript）を確実に取得
            const text = result[0].transcript;

            // 万が一データがうまく取れなかった場合はスキップ
            if (text === undefined || text === null) continue;

            if (result.isFinal) {
                finalTranscript += text + '\n';
            } else {
                interimTranscript += text;
            }
        }

        // 💡 画面のテキストエリアに反映（undefinedの混入を防ぐ）
        if (finalTranscript !== '') {
            transcriptArea.value += finalTranscript;
        }

        // 画面を自動で最下部までスクロール
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
            alert('エラー: ' + data.error);
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
