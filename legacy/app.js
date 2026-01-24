/**
 * 投資運用支援システム Logic v1.3
 */

const CONFIG = {
    INITIAL_CAPITAL: 900000,
    LIMIT_RESERVE: 300000,
    LIMIT_LONG_TOTAL: 300000,
    LIMIT_LONG_SINGLE: 300000
};

class InvestmentSystem {
    constructor() {
        this.assets = [];
        this.actionLogs = [];
        this.ignoredSignals = []; 
        this.chartInstance = null;
        
        this.loadFromStorage();
        this.renderDate();
        
        if (this.assets.length === 0) {
            document.getElementById('csvInput').value = this.getTestData();
        } else {
            this.updateDashboard();
        }
    }

    // --- Data Parsing ---

    getTestData() {
        // デフォルトの日付を作成 (YYYY-MM-DD)
        const today = new Date();
        const fmt = d => d.toISOString().split('T')[0];
        const dateStr = fmt(today);
        
        // 過去の日付（営業日計算テスト用）
        const pastDate = new Date();
        pastDate.setDate(pastDate.getDate() - 40); // 40日前
        const pastStr = fmt(pastDate);

        return `Ticker,Name,Portfolio,Type,TradeDate,Value,CostBasis,PL_Pct,Trend_Day
CASH_RESERVE,予備費,Reserve,Cash,${dateStr},300000,300000,0.0,Range
CASH_LONG,長期余力,Long,Cash,${dateStr},58408,58408,0.0,Range
CASH_MED,中期余力,Medium,Cash,${dateStr},36211,36211,0.0,Range
1662,石油資源開発,Long,Stock,${pastStr},188700,185115,1.93,Range
ALAB,アステラ・ラブス,Long,Stock,${dateStr},52892,56443,-6.29,Down
CRWD,クラウドストライク,Medium,Stock,${dateStr},71326,74570,-4.35,Down
XOM,エクソンモービル,Medium,Stock,${pastStr},45699,42240,8.77,Up
MU,マイクロン,Medium,Stock,${dateStr},124753,126988,-1.76,Up`;
    }

    processInput() {
        const rawText = document.getElementById('csvInput').value.trim();
        if (!rawText) return;

        const lines = rawText.split('\n');
        const data = [];
        
        // CSVヘッダー: Ticker, Name, Portfolio, Type, TradeDate, Value, CostBasis, PL_Pct, Trend_Day
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            const row = line.split(',');
            
            const obj = {
                Ticker: row[0]?.trim() || '',
                Name: row[1]?.trim() || '',
                Portfolio: row[2]?.trim() || '',
                Type: row[3]?.trim() || '',
                Value: parseFloat(row[5]) || 0,
                CostBasis: parseFloat(row[6]) || 0,
                PL_Pct: parseFloat(row[7]) || 0,
                Trend_Day: row[8]?.trim() || 'Range'
            };
            data.push(obj);
        }

        this.assets = data;
        this.saveToStorage();
        this.updateDashboard();
        alert('データを更新しました');
    }

    // --- Business Logic ---

    // 営業日ベースの経過日数計算 (土日除外)
    calculateBusinessDays(startDateStr) {
        if (!startDateStr) return 0;
        
        const start = new Date(startDateStr);
        const end = new Date(); // 今日
        
        // 時間リセット
        start.setHours(0,0,0,0);
        end.setHours(0,0,0,0);

        if (start > end) return 0;

        let count = 0;
        let current = new Date(start);

        while (current < end) {
            // 日付を1日進める
            current.setDate(current.getDate() + 1);
            const dayOfWeek = current.getDay();
            // 土曜(6)と日曜(0)以外をカウント
            if (dayOfWeek !== 0 && dayOfWeek !== 6) {
                count++;
            }
        }
        return count;
    }

    calculateStats() {
        const totalValue = this.assets.reduce((sum, item) => sum + item.Value, 0);
        const ddPct = ((totalValue - CONFIG.INITIAL_CAPITAL) / CONFIG.INITIAL_CAPITAL) * 100;

        const allocation = { Reserve: 0, Long: 0, Medium: 0 };
        const longStocks = [];

        this.assets.forEach(a => {
            if (allocation[a.Portfolio] !== undefined) {
                allocation[a.Portfolio] += a.Value;
            }
            if (a.Portfolio === 'Long' && a.Type !== 'Cash') {
                longStocks.push(a);
            }
        });

        const alerts = [];
        if (ddPct <= -12) alerts.push({ level: 'FATAL', msg: '年次DD超過 (-12%): 直ちに運用を停止してください' });
        else if (ddPct <= -6) alerts.push({ level: 'CRITICAL', msg: '月次DD超過 (-6%): 新規建玉禁止' });

        const cashReserve = this.assets.find(a => a.Ticker === 'CASH_RESERVE');
        const reserveValue = cashReserve ? cashReserve.Value : 0;

        if (reserveValue < CONFIG.LIMIT_RESERVE) {
            alerts.push({ level: 'WARN', msg: `保証金不足: 30万円を下回っています` });
        }
        if (allocation.Long > CONFIG.LIMIT_LONG_TOTAL) {
            alerts.push({ level: 'WARN', msg: `長期枠超過: 30万円を超えています` });
        }
        longStocks.forEach(s => {
            if (s.Value > CONFIG.LIMIT_LONG_SINGLE) {
                alerts.push({ level: 'WARN', msg: `銘柄上限超過(${s.Ticker}): 10万円を超えています` });
            }
        });

        return { totalValue, ddPct, allocation, alerts };
    }

    generateSignal(asset) {
        if (asset.Type === 'Cash') return null;

        const pl = asset.PL_Pct;
        const trend = asset.Trend_Day;
        // 営業日計算
        const daysHeld = this.calculateBusinessDays(asset.TradeDate);
        
        let result = null;

        // A. 長期ポートフォリオ
        if (asset.Portfolio === 'Long') {
            if (pl <= -12) result = { type: 'SELL', label: 'STOP LOSS', reason: '損切りライン(-12%)到達' };
            else if (pl >= 50) result = { type: 'SELL', label: 'TAKE PROFIT (Target 2)', reason: '第2利確(+50%)到達' };
            else if (pl >= 30) result = { type: 'SELL', label: 'TAKE PROFIT (Target 1)', reason: '第1利確(+30%)到達' };
            else if (trend === 'Down') result = { type: 'SELL', label: 'SELL ALL', reason: 'トレンド転換(Down)' };
        }
        // B. 中期ポートフォリオ
        else if (asset.Portfolio === 'Medium') {
            if (asset.Type === 'MarginShort') {
                if (pl <= -5) result = { type: 'BUY_BACK', label: 'STOP LOSS', reason: '損切りライン(-5%)到達' };
                else if (pl >= 6) result = { type: 'BUY_BACK', label: 'TAKE PROFIT', reason: '利確ライン(+6%)到達' };
            } else {
                if (asset.Type === 'MarginLong' && pl <= -6) result = { type: 'SELL', label: 'STOP LOSS', reason: '信用損切り(-6%)到達' };
                else if (asset.Type === 'Stock' && pl <= -10) result = { type: 'SELL', label: 'STOP LOSS', reason: '現物損切り(-10%)到達' };
                else if (pl >= 12) result = { type: 'SELL', label: 'TAKE PROFIT (Target 2)', reason: '第2利確(+12%)到達' };
                else if (pl >= 8) result = { type: 'SELL', label: 'TAKE PROFIT (Target 1)', reason: '第1利確(+8%)到達' };
                
                // 期間期限（営業日ベースで20日）
                if (daysHeld > 20) result = { type: 'SELL', label: 'TIME LIMIT', reason: `保有期限超過 (${daysHeld}営業日)` };
            }
        }

        // 無視リストチェック
        if (result) {
            // TickerとSignalLabelの組み合わせでチェック
            const isIgnored = this.ignoredSignals.some(s => s.ticker === asset.Ticker && s.signalType === result.label);
            if (isIgnored) return null;
        }

        return result;
    }

    // --- View & Interaction ---

    // 約定日が変更されたときに呼ばれる
    updateAssetDate(ticker, newDate) {
        const asset = this.assets.find(a => a.Ticker === ticker);
        if (asset) {
            asset.TradeDate = newDate;
            this.saveToStorage();
            this.updateDashboard(); // 再計算・再描画
        }
    }

    updateDashboard() {
        const stats = this.calculateStats();
        
        document.getElementById('totalValue').innerText = `¥${stats.totalValue.toLocaleString()}`;
        const ddElem = document.getElementById('drawdown');
        ddElem.innerText = `${stats.ddPct.toFixed(2)}%`;
        ddElem.className = `text-xl font-bold ${stats.ddPct < 0 ? 'text-red-600' : 'text-green-600'}`;
        document.getElementById('complianceRate').innerText = `${this.calculateCompliance()}%`;
        this.renderChart(stats.allocation);

        const alertContainer = document.getElementById('allocationAlerts');
        alertContainer.innerHTML = '';
        stats.alerts.forEach(alert => {
            const div = document.createElement('div');
            div.className = `p-2 text-xs rounded ${alert.level.includes('FATAL') ? 'bg-red-200 text-red-800' : 'bg-yellow-100 text-yellow-800'}`;
            div.innerText = `[${alert.level}] ${alert.msg}`;
            alertContainer.appendChild(div);
        });

        const tbody = document.getElementById('assetTableBody');
        const actionList = document.getElementById('actionList');
        const actionSection = document.getElementById('actionRequiredSection');
        
        tbody.innerHTML = '';
        actionList.innerHTML = '';
        let signalCount = 0;

        this.assets.forEach(asset => {
            const signal = this.generateSignal(asset);
            const daysHeld = this.calculateBusinessDays(asset.TradeDate);
            
            // テーブル行生成
            const tr = document.createElement('tr');
            tr.className = "hover:bg-gray-50 transition-colors";
            tr.innerHTML = `
                <td class="p-2 font-bold">${asset.Ticker}</td>
                <td class="p-2 text-gray-600 max-w-xs truncate" title="${asset.Name}">${asset.Name}</td>
                <td class="p-2 text-xs text-gray-500">${asset.Portfolio}<br>${asset.Type}</td>
                <td class="p-2">
                    <input type="date" value="${asset.TradeDate}" 
                           onchange="app.updateAssetDate('${asset.Ticker}', this.value)"
                           class="bg-white text-xs">
                    <span class="text-xs text-gray-500 ml-1">(${daysHeld}日)</span>
                </td>
                <td class="p-2 text-right">¥${asset.Value.toLocaleString()}</td>
                <td class="p-2 text-right ${asset.PL_Pct > 0 ? 'text-green-600' : (asset.PL_Pct < 0 ? 'text-red-600' : '')}">${asset.PL_Pct}%</td>
                <td class="p-2 text-xs">${asset.Trend_Day}</td>
                <td class="p-2">
                    ${signal ? `<span class="bg-red-100 text-red-800 text-xs px-2 py-1 rounded font-bold whitespace-nowrap block text-center">${signal.label}</span>` : '<span class="text-green-500 text-xs font-bold">OK</span>'}
                </td>
            `;
            tbody.appendChild(tr);

            // アラートカード生成
            if (signal) {
                signalCount++;
                const card = document.createElement('div');
                card.className = "bg-white p-3 border rounded shadow-sm flex justify-between items-center";
                card.innerHTML = `
                    <div>
                        <div class="font-bold flex items-center gap-2">
                            ${asset.Ticker} 
                            <span class="text-xs font-normal text-gray-500">(${asset.Name})</span>
                        </div>
                        <div class="text-red-600 font-bold text-sm mt-1">${signal.label}</div>
                        <div class="text-xs text-gray-500">理由: ${signal.reason}</div>
                    </div>
                    <div class="flex flex-col gap-2">
                        <button onclick="app.executeAction('${asset.Ticker}', '${signal.label}')" class="bg-red-600 text-white text-xs px-3 py-1 rounded hover:bg-red-700 shadow">実行記録</button>
                        <button onclick="app.ignoreAction('${asset.Ticker}', '${signal.label}')" class="bg-gray-200 text-gray-700 text-xs px-3 py-1 rounded hover:bg-gray-300 border">無視</button>
                    </div>
                `;
                actionList.appendChild(card);
            }
        });

        document.getElementById('actionCount').innerText = signalCount;
        if (signalCount > 0) actionSection.classList.remove('hidden');
        else actionSection.classList.add('hidden');

        this.renderLogs();
    }

    // --- Actions ---

    executeAction(ticker, action) {
        if(!confirm(`${ticker} のアクション「${action}」を実行済として記録しますか？`)) return;
        this.addLog(ticker, action, 'EXECUTE');
    }

    ignoreAction(ticker, actionLabel) {
        const reason = prompt("無視する理由を入力してください:");
        if (reason === null) return; // キャンセル

        // 無視リストに追加
        this.ignoredSignals.push({ ticker: ticker, signalType: actionLabel });
        this.addLog(ticker, 'IGNORE', 'IGNORE', reason);
        
        this.saveToStorage();
        this.updateDashboard(); // 即座に再描画してアラートを消す
    }
    
    clearIgnoredSignals() {
        if(!confirm("無視リストをリセットし、全てのアラートを再表示しますか？")) return;
        this.ignoredSignals = [];
        this.saveToStorage();
        this.updateDashboard();
    }

    addLog(ticker, action, type, reason = '') {
        const log = {
            date: new Date().toLocaleString(),
            ticker, action, type, reason
        };
        this.actionLogs.unshift(log);
        this.saveToStorage();
        this.renderLogs();
    }

    renderLogs() {
        const list = document.getElementById('logList');
        list.innerHTML = this.actionLogs.map(log => `
            <li class="border-b py-1 flex gap-2">
                <span class="text-gray-400 w-32 shrink-0">[${log.date}]</span> 
                <span class="font-bold w-16 shrink-0 ${log.type === 'EXECUTE' ? 'text-blue-600' : 'text-gray-500'}">${log.type}</span>
                <span class="truncate flex-1">${log.ticker} - ${log.action} ${log.reason ? `(${log.reason})` : ''}</span>
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
        if (this.chartInstance) this.chartInstance.destroy();
        this.chartInstance = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Reserve', 'Long', 'Medium'],
                datasets: [{
                    data: [allocation.Reserve, allocation.Long, allocation.Medium],
                    backgroundColor: ['#E5E7EB', '#1E3A8A', '#3B82F6'],
                    hoverOffset: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom' } }
            }
        });
    }

    renderDate() {
        const now = new Date();
        document.getElementById('currentDate').innerText = now.toLocaleDateString('ja-JP', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }
    
    saveToStorage() {
        localStorage.setItem('invest_assets', JSON.stringify(this.assets));
        localStorage.setItem('invest_logs', JSON.stringify(this.actionLogs));
        localStorage.setItem('invest_ignored', JSON.stringify(this.ignoredSignals));
    }

    loadFromStorage() {
        const assets = localStorage.getItem('invest_assets');
        const logs = localStorage.getItem('invest_logs');
        const ignored = localStorage.getItem('invest_ignored');
        
        if (assets) this.assets = JSON.parse(assets);
        if (logs) this.actionLogs = JSON.parse(logs);
        if (ignored) this.ignoredSignals = JSON.parse(ignored);
    }

    resetData() {
        if(!confirm("データを全て消去しますか？")) return;
        localStorage.clear();
        location.reload();
    }
}

const app = new InvestmentSystem();