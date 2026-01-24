# trading_operations
株式取引運用関連のドキュメント・ソースコードの管理

## Streamlit (簡易認証つき)

ローカル実行:

```bash
pip install -r requirements.txt
streamlit run streamlit_app.py
```

認証情報は以下のどちらかで設定できます。

- Streamlit CloudのSecrets:

```toml
[auth]
username = "your_id"
password = "your_password"
```

- ローカル環境変数:
  - `APP_USERNAME`
  - `APP_PASSWORD`

## Legacy (HTML/JS)

旧フロントは `legacy/` に移動しました。

### CSV項目（Streamlit版）

```
Ticker,Name,Portfolio,Type,TradeDate,Value,CostBasis,PL_Pct,Trend_Day,Country,Event,ShortReason
```

- `Country`: `JP` / `US` / `Other`
- `Event`: `None` / `EarningsUpcoming` / `Earnings` / `Policy` / `Industry`
