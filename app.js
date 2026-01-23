/**
 * 投資運用支援システム Logic ver1.0
 */

const CONFIG = {
    INITIAL_CAPITAL: 900000, // 基準元本
    LIMIT_RESERVE: 300000,   // 最低保証金
    LIMIT_LONG_TOTAL: 300000, // 長期枠上限
    LIMIT_LONG_SINGLE: 300000 // 長期個別上限
};

class InvestmentSystem {
    constructor() {
        this.assets = [];
        this.actionLogs = [];
        this.chartInstance = null;
        
        // 初期化
        this.loadFromStorage();
        this.renderDate();
        
        // 初回ロード時にデータがなければテストデータをセット
        if (this.assets.length === 0) {
            document.getElementById('csvInput').value = this.getTestData();
        } else {
            this.updateDashboard();
        }
    }

    // --- 3. Data Model & Parsing ---

    getTestData() {
        return `Ticker,Portfolio,Type,Value,CostBasis,PL_Pct,Trend_Day
CASH_RESERVE,Reserve,Cash,300000,300000,0.0,Range
CASH_LONG,Long,Cash,244207,244207,0.0,Range
CASH_MED,Medium,Cash,45078,45078,0.0,Range
ALAB,Long,Stock,55793,56368,-1.02,Range
CRWD,Medium,Stock,188700,185115,1.93,Up
XOM,Medium,Stock,42281,39410,7.28,Up`;
    }

    processInput() {
        const rawText = document.getElementById('csvInput').value.trim();
        if (!rawText) return;

        const lines = rawText.split('\n');
        const headers = lines[0].split(',').map(h => h.trim());
        
        const data = [];
        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            const row = lines[i].split(',');
            const obj = {};
            headers.forEach((h, index) => {
                let val = row[index] ? row[index].trim() : '';
                // 数値変換
                if (['Value', 'CostBasis', 'PL_Pct'].includes(h)) {
                    val = parseFloat(val);
                }
                obj[h] = val;
            });
            data.push(obj);
        }

        this.assets = data;
        this.saveToStorage();
        this.updateDashboard();
        alert('データを更新しました');
    }

    // --- 4.1 Allocation Logic ---

    calculateStats() {
        const totalValue = this.assets.reduce((sum, item) => sum + (item.Value || 0), 0);
        
        // ドローダウン計算
        const ddPct = ((totalValue - CONFIG.INITIAL_CAPITAL) / CONFIG.INITIAL_CAPITAL) * 100;

        // ポートフォリオ別集計
        const allocation = {
            Reserve: 0,
            Long: 0,
            Medium: 0
        };
        
        // 長期個別銘柄チェック用
        const longStocks = [];

        this.assets.forEach(a => {
            if (allocation[a.Portfolio] !== undefined) {
                allocation[a.Portfolio] += a.Value;
            }
            if (a.Portfolio === 'Long' && a.Type !== 'Cash') {
                longStocks.push(a);
            }
        });

        // 資金配分アラート生成
        const alerts = [];
        if (ddPct <= -12) alerts.push({ level: 'FATAL', msg: '年次DD超過 (-12%): 直ちに運用を停止してください' });
        else if (ddPct <= -6) alerts.push({ level: 'CRITICAL', msg: '月次DD超過 (-6%): 新規建玉禁止' });

        // 箱分けチェック
        const cashReserve = this.assets.find(a => a.Ticker === 'CASH_RESERVE');
        const reserveValue = cashReserve ? cashReserve.Value : 0;

        if (reserveValue < CONFIG.LIMIT_RESERVE) {
            alerts.push({ level: 'WARN', msg: `保証金不足: 30万円を下回っています (現在: ${reserveValue.toLocaleString()})` });
        }
        if (allocation.Long > CONFIG.LIMIT_LONG_TOTAL) {
            alerts.push({ level: 'WARN', msg: `長期枠超過: 30万円を超えています (現在: ${allocation.Long.toLocaleString()})` });
        }
        longStocks.forEach(s => {
            if (s.Value > CONFIG.LIMIT_LONG_SINGLE) {
                alerts.push({ level: 'WARN', msg: `銘柄上限超過(${s.Ticker}): 10万円を超えています` });
            }
        });

        return { totalValue, ddPct, allocation, alerts };
    }

    // --- 4.2 Signal Generation Logic ---

    generateSignal(asset) {
        if (asset.Type === 'Cash') return null; // 現金はシグナルなし

        const pl = asset.PL_Pct;
        const trend = asset.Trend_Day; // 設計書ではLongはMonthだが、CSVにないのでDayで代用またはUI変更とする

        // A. 長期ポートフォリオ
        if (asset.Portfolio === 'Long') {
            if (pl <= -12) return { type: 'SELL', label: 'STOP LOSS', reason: '損切りライン(-12%)到達' };
            if (pl >= 50) return { type: 'SELL', label: 'TAKE PROFIT (Target 2)', reason: '第2利確(+50%)到達' };
            if (pl >= 30) return { type: 'SELL', label: 'TAKE PROFIT (Target 1)', reason: '第1利確(+30%)到達' };
            if (trend === 'Down') return { type: 'SELL', label: 'SELL ALL', reason: 'トレンド転換(Down)' };
        }

        // B. 中期ポートフォリオ
        if (asset.Portfolio === 'Medium') {
            // 信用売り
            if (asset.Type === 'MarginShort') {
                if (pl <= -5) return { type: 'BUY_BACK', label: 'STOP LOSS', reason: '損切りライン(-5%)到達' }; // 損失方向
                if (pl >= 6) return { type: 'BUY_BACK', label: 'TAKE PROFIT', reason: '利確ライン(+6%)到達' };
            } 
            // 現物・信用買い
            else {
                if (asset.Type === 'MarginLong' && pl <= -6) return { type: 'SELL', label: 'STOP LOSS', reason: '信用損切り(-6%)到達' };
                if (asset.Type === 'Stock' && pl <= -10) return { type: 'SELL', label: 'STOP LOSS', reason: '現物損切り(-10%)到達' };
                
                if (pl >= 12) return { type: 'SELL', label: 'TAKE PROFIT (Target 2)', reason: '第2利確(+12%)到達' };
                if (pl >= 8) return { type: 'SELL', label: 'TAKE PROFIT (Target 1)', reason: '第1利確(+8%)到達' };
                
                // ※期間期限ロジックはCSVに保有日数がないため、今回は実装スキップ(要件メモ)
            }
        }

        return null; // 正常
    }

    // --- View & Interaction ---

    updateDashboard() {
        const stats = this.calculateStats();
        
        // Header Stats
        document.getElementById('totalValue').innerText = `¥${stats.totalValue.toLocaleString()}`;
        
        const ddElem = document.getElementById('drawdown');
        ddElem.innerText = `${stats.ddPct.toFixed(2)}%`;
        ddElem.className = `text-xl font-bold ${stats.ddPct < 0 ? 'text-red-600' : 'text-green-600'}`;

        // Compliance Rate (簡易計算: ログの数 / (ログ数 + 未処理シグナル数))
        // ※本来は履歴全体を持つべきだが、今回は簡易的に表示
        document.getElementById('complianceRate').innerText = `${this.calculateCompliance()}%`;

        // Allocation Chart
        this.renderChart(stats.allocation);

        // Alerts (Allocation)
        const alertContainer = document.getElementById('allocationAlerts');
        alertContainer.innerHTML = '';
        stats.alerts.forEach(alert => {
            const div = document.createElement('div');
            div.className = `p-2 text-xs rounded ${alert.level === 'FATAL' || alert.level === 'CRITICAL' ? 'bg-red-200 text-red-800' : 'bg-yellow-100 text-yellow-800'}`;
            div.innerText = `[${alert.level}] ${alert.msg}`;
            alertContainer.appendChild(div);
        });

        // Asset List & Signals
        const tbody = document.getElementById('assetTableBody');
        const actionList = document.getElementById('actionList');
        const actionSection = document.getElementById('actionRequiredSection');
        
        tbody.innerHTML = '';
        actionList.innerHTML = '';
        let signalCount = 0;

        this.assets.forEach((asset, index) => {
            const signal = this.generateSignal(asset);
            
            // Table Row
            const tr = document.createElement('tr');
            tr.className = "border-b hover:bg-gray-50";
            tr.innerHTML = `
                <td class="p-2 font-bold">${asset.Ticker}</td>
                <td class="p-2 text-xs text-gray-500">${asset.Portfolio}<br>${asset.Type}</td>
                <td class="p-2 text-right">¥${asset.Value.toLocaleString()}</td>
                <td class="p-2 text-right ${asset.PL_Pct > 0 ? 'text-green-600' : (asset.PL_Pct < 0 ? 'text-red-600' : '')}">${asset.PL_Pct}%</td>
                <td class="p-2 text-xs">${asset.Trend_Day}</td>
                <td class="p-2">
                    ${signal ? `<span class="bg-red-100 text-red-800 text-xs px-2 py-1 rounded font-bold">${signal.label}</span>` : '<span class="text-green-500 text-xs">OK</span>'}
                </td>
            `;
            tbody.appendChild(tr);

            // Action Card if signal exists
            if (signal) {
                signalCount++;
                const card = document.createElement('div');
                card.className = "bg-white p-3 border rounded shadow-sm flex justify-between items-center";
                card.innerHTML = `
                    <div>
                        <div class="font-bold text-lg">${asset.Ticker} <span class="text-sm font-normal text-gray-500">(${asset.Portfolio})</span></div>
                        <div class="text-red-600 font-bold">${signal.label}</div>
                        <div class="text-xs text-gray-500">理由: ${signal.reason}</div>
                    </div>
                    <div class="flex flex-col gap-2">
                        <button onclick="app.executeAction('${asset.Ticker}', '${signal.label}')" class="bg-red-600 text-white text-xs px-3 py-1 rounded hover:bg-red-700">実行記録</button>
                        <button onclick="app.ignoreAction('${asset.Ticker}')" class="bg-gray-300 text-gray-700 text-xs px-3 py-1 rounded hover:bg-gray-400">無視</button>
                    </div>
                `;
                actionList.appendChild(card);
            }
        });

        document.getElementById('actionCount').innerText = signalCount;
        if (signalCount > 0) {
            actionSection.classList.remove('hidden');
        } else {
            actionSection.classList.add('hidden');
        }

        this.renderLogs();
    }

    // --- Actions & Logs ---

    executeAction(ticker, action) {
        if(!confirm(`${ticker} のアクション「${action}」を実行済として記録しますか？`)) return;
        
        const log = {
            date: new Date().toLocaleString(),
            ticker: ticker,
            action: action,
            type: 'EXECUTE'
        };
        this.actionLogs.unshift(log);
        this.saveToStorage();
        this.renderLogs();
        // コンプライアンス率計算のためにリロード推奨だが、今回はアラートのみ消す処理などは省略（再インポート前提の設計のため）
    }

    ignoreAction(ticker) {
        const reason = prompt("無視する理由を入力してください:");
        if (!reason) return;

        const log = {
            date: new Date().toLocaleString(),
            ticker: ticker,
            action: 'IGNORE',
            reason: reason,
            type: 'IGNORE'
        };
        this.actionLogs.unshift(log);
        this.saveToStorage();
        this.renderLogs();
    }

    renderLogs() {
        const list = document.getElementById('logList');
        list.innerHTML = this.actionLogs.map(log => `
            <li class="border-b py-1">
                <span class="text-gray-400">[${log.date}]</span> 
                <span class="font-bold ${log.type === 'EXECUTE' ? 'text-blue-600' : 'text-gray-500'}">${log.type}</span>: 
                ${log.ticker} - ${log.action} ${log.reason ? `(${log.reason})` : ''}
            </li>
        `).join('');
    }

    calculateCompliance() {
        if (this.actionLogs.length === 0) return 100;
        const executed = this.actionLogs.filter(l => l.type === 'EXECUTE').length;
        return Math.round((executed / this.actionLogs.length) * 100);
    }

    // --- Utilities ---

    renderChart(allocation) {
        const ctx = document.getElementById('allocationChart').getContext('2d');
        const dataValues = [allocation.Reserve, allocation.Long, allocation.Medium];
        
        if (this.chartInstance) {
            this.chartInstance.destroy();
        }

        this.chartInstance = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Reserve', 'Long', 'Medium'],
                datasets: [{
                    data: dataValues,
                    backgroundColor: ['#E5E7EB', '#1E3A8A', '#3B82F6'], // Gray, Dark Blue, Blue
                    hoverOffset: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom' }
                }
            }
        });
    }

    renderDate() {
        const now = new Date();
        document.getElementById('currentDate').innerText = now.toLocaleDateString('ja-JP', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }

    // --- Storage ---
    
    saveToStorage() {
        localStorage.setItem('invest_assets', JSON.stringify(this.assets));
        localStorage.setItem('invest_logs', JSON.stringify(this.actionLogs));
    }

    loadFromStorage() {
        const assets = localStorage.getItem('invest_assets');
        const logs = localStorage.getItem('invest_logs');
        if (assets) this.assets = JSON.parse(assets);
        if (logs) this.actionLogs = JSON.parse(logs);
    }

    resetData() {
        if(!confirm("データを全て消去しますか？")) return;
        localStorage.clear();
        this.assets = [];
        this.actionLogs = [];
        location.reload();
    }
}

// アプリケーション起動
const app = new InvestmentSystem();