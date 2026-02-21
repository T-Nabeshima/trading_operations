import json
import os
import tempfile
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

import matplotlib.pyplot as plt
import pandas as pd
import streamlit as st
import streamlit_authenticator as stauth

CONFIG = {
    "INITIAL_CAPITAL": 900000,
    "LIMIT_RESERVE": 300000,
    "LIMIT_LONG_TOTAL": 300000,
    "LIMIT_LONG_SINGLE": 300000,
    "LIMIT_MEDIUM_STOCK": 300000,
    "LIMIT_MEDIUM_MARGIN_LONG": 350000,
    "LIMIT_MEDIUM_MARGIN_SHORT": 200000,
    "LIMIT_MARGIN_TOTAL": 750000,
    "LIMIT_EXPOSURE_TOTAL": 1350000,
    "LIMIT_MARGIN_DAYS": 20,
    "LIMIT_SHORT_DAYS": 10,
}

STORAGE_PATH = os.path.join("data", "storage.json")


def get_test_csv() -> str:
    today = date.today()
    date_str = today.isoformat()

    past_date = today - timedelta(days=40)
    past_str = past_date.isoformat()

    return (
        "Ticker,Name,Portfolio,Type,TradeDate,Value,CostBasis,PL_Pct,Trend_Day,Country,Event,ShortReason\n"
        f"CASH_RESERVE,予備費,Reserve,Cash,{date_str},300000,300000,0.0,Range,JP,None,\n"
        f"CASH_LONG,長期余力,Long,Cash,{date_str},58408,58408,0.0,Range,JP,None,\n"
        f"CASH_MED,中期余力,Medium,Cash,{date_str},36211,36211,0.0,Range,JP,None,\n"
        f"1662,石油資源開発,Long,Stock,{past_str},188700,185115,1.93,Range,JP,None,\n"
        f"ALAB,アステラ・ラブス,Long,Stock,{date_str},52892,56443,-6.29,Down,US,None,\n"
        f"CRWD,クラウドストライク,Medium,Stock,{date_str},71326,74570,-4.35,Down,US,None,\n"
        f"XOM,エクソンモービル,Medium,Stock,{past_str},45699,42240,8.77,Up,US,None,\n"
        f"MU,マイクロン,Medium,Stock,{date_str},124753,126988,-1.76,Up,US,None,"
    )


def parse_csv(text: str) -> List[Dict[str, Any]]:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) <= 1:
        return []

    data: List[Dict[str, Any]] = []
    for line in lines[1:]:
        row = [col.strip() for col in line.split(",")]
        data.append(
            {
                "Ticker": row[0] if len(row) > 0 else "",
                "Name": row[1] if len(row) > 1 else "",
                "Portfolio": row[2] if len(row) > 2 else "",
                "Type": row[3] if len(row) > 3 else "",
                "TradeDate": row[4] if len(row) > 4 else "",
                "Value": float(row[5]) if len(row) > 5 and row[5] else 0.0,
                "CostBasis": float(row[6]) if len(row) > 6 and row[6] else 0.0,
                "PL_Pct": float(row[7]) if len(row) > 7 and row[7] else 0.0,
                "Trend_Day": row[8] if len(row) > 8 else "Range",
                "Country": row[9] if len(row) > 9 else "JP",
                "Event": row[10] if len(row) > 10 else "None",
                "ShortReason": row[11] if len(row) > 11 else "",
            }
        )
    return data


def assets_to_csv(assets: List[Dict[str, Any]]) -> str:
    header = "Ticker,Name,Portfolio,Type,TradeDate,Value,CostBasis,PL_Pct,Trend_Day,Country,Event,ShortReason"
    lines = [header]
    for asset in assets:
        lines.append(
            ",".join(
                [
                    str(asset.get("Ticker", "")),
                    str(asset.get("Name", "")),
                    str(asset.get("Portfolio", "")),
                    str(asset.get("Type", "")),
                    str(asset.get("TradeDate", "")),
                    str(asset.get("Value", 0)),
                    str(asset.get("CostBasis", 0)),
                    str(asset.get("PL_Pct", 0)),
                    str(asset.get("Trend_Day", "")),
                    str(asset.get("Country", "")),
                    str(asset.get("Event", "None")),
                    str(asset.get("ShortReason", "")),
                ]
            )
        )
    return "\n".join(lines)


def normalize_assets(assets: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    for asset in assets:
        asset.setdefault("Country", "JP")
        asset.setdefault("Event", "None")
        asset.setdefault("ShortReason", "")
        asset.setdefault("Trend_Day", "Range")
    return assets


def merge_assets(existing_assets: List[Dict[str, Any]], new_assets: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    merged = [dict(asset) for asset in existing_assets]
    key_to_index = {}

    for i, asset in enumerate(merged):
        key = (asset.get("Ticker"), asset.get("Portfolio"), asset.get("Type"))
        key_to_index[key] = i

    for asset in new_assets:
        key = (asset.get("Ticker"), asset.get("Portfolio"), asset.get("Type"))
        if key in key_to_index:
            merged[key_to_index[key]] = dict(asset)
        else:
            key_to_index[key] = len(merged)
            merged.append(dict(asset))

    return merged


def calculate_business_days(start_date_str: str) -> int:
    if not start_date_str:
        return 0
    try:
        start = datetime.strptime(start_date_str, "%Y-%m-%d").date()
    except ValueError:
        return 0

    end = date.today()
    if start > end:
        return 0

    count = 0
    current = start
    while current < end:
        current += timedelta(days=1)
        if current.weekday() < 5:
            count += 1
    return count


def calculate_stats(assets: List[Dict[str, Any]], index_trend: str) -> Dict[str, Any]:
    total_value = sum(a.get("Value", 0) for a in assets)
    dd_pct = ((total_value - CONFIG["INITIAL_CAPITAL"]) / CONFIG["INITIAL_CAPITAL"]) * 100

    allocation = {"Reserve": 0.0, "Long": 0.0, "Medium": 0.0}
    long_stocks = []
    medium_stock = 0.0
    medium_margin_long = 0.0
    medium_margin_short = 0.0
    total_exposure = 0.0

    for a in assets:
        portfolio = a.get("Portfolio")
        asset_type = a.get("Type")
        if portfolio in allocation:
            allocation[portfolio] += a.get("Value", 0)
        if portfolio == "Long" and asset_type != "Cash":
            long_stocks.append(a)
        if portfolio == "Medium" and asset_type == "Stock":
            medium_stock += a.get("Value", 0)
        if portfolio == "Medium" and asset_type == "MarginLong":
            medium_margin_long += a.get("Value", 0)
        if portfolio == "Medium" and asset_type == "MarginShort":
            medium_margin_short += a.get("Value", 0)
        if asset_type != "Cash":
            total_exposure += a.get("Value", 0)

    alerts = []
    if dd_pct <= -12:
        alerts.append({"level": "FATAL", "msg": "年次DD超過 (-12%): 直ちに運用を停止してください"})
    elif dd_pct <= -6:
        alerts.append({"level": "CRITICAL", "msg": "月次DD超過 (-6%): 新規建玉禁止"})

    cash_reserve = next((a for a in assets if a.get("Ticker") == "CASH_RESERVE"), None)
    reserve_value = cash_reserve.get("Value", 0) if cash_reserve else 0

    if reserve_value < CONFIG["LIMIT_RESERVE"]:
        alerts.append({"level": "WARN", "msg": "保証金不足: 30万円を下回っています"})
    if allocation["Long"] > CONFIG["LIMIT_LONG_TOTAL"]:
        alerts.append({"level": "WARN", "msg": "長期枠超過: 30万円を超えています"})
    if allocation["Medium"] > CONFIG["LIMIT_LONG_TOTAL"]:
        alerts.append({"level": "WARN", "msg": "中期枠超過: 30万円を超えています"})
    for s in long_stocks:
        if s.get("Value", 0) > CONFIG["LIMIT_LONG_SINGLE"]:
            alerts.append({"level": "WARN", "msg": f"銘柄上限超過({s.get('Ticker')}): 30万円を超えています"})

    if medium_stock > CONFIG["LIMIT_MEDIUM_STOCK"]:
        alerts.append({"level": "WARN", "msg": "中期現物枠超過: 30万円を超えています"})
    if medium_margin_long > CONFIG["LIMIT_MEDIUM_MARGIN_LONG"]:
        alerts.append({"level": "WARN", "msg": "信用買い枠超過: 35万円を超えています"})
    if medium_margin_short > CONFIG["LIMIT_MEDIUM_MARGIN_SHORT"]:
        alerts.append({"level": "WARN", "msg": "信用売り枠超過: 20万円を超えています"})
    if (medium_margin_long + medium_margin_short) > CONFIG["LIMIT_MARGIN_TOTAL"]:
        alerts.append({"level": "WARN", "msg": "信用建玉合計上限超過: 75万円を超えています"})
    if total_exposure > CONFIG["LIMIT_EXPOSURE_TOTAL"]:
        alerts.append({"level": "WARN", "msg": "最大エクスポージャ超過: 135万円を超えています"})

    for a in assets:
        asset_type = a.get("Type")
        country = a.get("Country")
        event = a.get("Event")
        ticker = a.get("Ticker")
        if country == "US" and asset_type in {"MarginLong", "MarginShort"}:
            alerts.append({"level": "WARN", "msg": f"米国株は現物のみ({ticker})"})
        if event == "EarningsUpcoming" and asset_type in {"MarginLong", "MarginShort"}:
            alerts.append({"level": "WARN", "msg": f"決算前は信用取引禁止({ticker})"})
        if asset_type == "MarginShort" and index_trend == "Up":
            alerts.append({"level": "WARN", "msg": f"指数上昇トレンド中は空売り禁止({ticker})"})
        if asset_type == "MarginShort" and not a.get("ShortReason"):
            alerts.append({"level": "WARN", "msg": f"空売り理由が未入力({ticker})"})

    return {"total_value": total_value, "dd_pct": dd_pct, "allocation": allocation, "alerts": alerts}


def generate_signal(
    asset: Dict[str, Any],
    ignored_signals: List[Dict[str, str]],
    index_trend: str,
) -> Optional[Dict[str, str]]:
    if asset.get("Type") == "Cash":
        return None

    pl = asset.get("PL_Pct", 0)
    trend = asset.get("Trend_Day", "Range")
    days_held = calculate_business_days(asset.get("TradeDate", ""))
    asset_type = asset.get("Type")
    event = asset.get("Event")

    result = None

    if asset_type == "MarginShort" and index_trend == "Up":
        result = {"type": "BUY_BACK", "label": "SHORT RESTRICTED", "reason": "指数上昇トレンドのため空売り禁止"}
    elif event == "EarningsUpcoming" and asset_type in {"MarginLong", "MarginShort"}:
        action_type = "SELL" if asset_type == "MarginLong" else "BUY_BACK"
        result = {"type": action_type, "label": "EARNINGS RESTRICT", "reason": "決算前は信用取引禁止"}

    if result is None and asset.get("Portfolio") == "Long":
        if pl <= -12:
            result = {"type": "SELL", "label": "STOP LOSS", "reason": "損切りライン(-12%)到達"}
        elif pl >= 50:
            result = {
                "type": "SELL",
                "label": "TAKE PROFIT (Target 2)",
                "reason": "第2利確(+50%)到達",
            }
        elif pl >= 30:
            result = {
                "type": "SELL",
                "label": "TAKE PROFIT (Target 1)",
                "reason": "第1利確(+30%)到達",
            }
        elif trend == "Down":
            result = {"type": "SELL", "label": "SELL ALL", "reason": "トレンド転換(Down)"}
    elif result is None and asset.get("Portfolio") == "Medium":
        if asset_type == "MarginShort":
            if pl <= -5:
                result = {"type": "BUY_BACK", "label": "STOP LOSS", "reason": "損切りライン(-5%)到達"}
            elif pl >= 10:
                result = {"type": "BUY_BACK", "label": "TAKE PROFIT (Target 2)", "reason": "第2利確(+10%)到達"}
            elif pl >= 6:
                result = {"type": "BUY_BACK", "label": "TAKE PROFIT (Target 1)", "reason": "第1利確(+6%)到達"}

            if days_held > CONFIG["LIMIT_SHORT_DAYS"]:
                result = {
                    "type": "BUY_BACK",
                    "label": "TIME LIMIT",
                    "reason": f"保有期限超過 ({days_held}営業日)",
                }
        elif asset_type == "MarginLong":
            if pl <= -6:
                result = {"type": "SELL", "label": "STOP LOSS", "reason": "信用損切り(-6%)到達"}
            elif pl >= 12:
                result = {"type": "SELL", "label": "TAKE PROFIT (Target 2)", "reason": "第2利確(+12%)到達"}
            elif pl >= 8:
                result = {"type": "SELL", "label": "TAKE PROFIT (Target 1)", "reason": "第1利確(+8%)到達"}

            if days_held > CONFIG["LIMIT_MARGIN_DAYS"]:
                result = {"type": "SELL", "label": "TIME LIMIT", "reason": f"保有期限超過 ({days_held}営業日)"}
        elif asset_type == "Stock":
            if pl <= -10:
                result = {"type": "SELL", "label": "STOP LOSS", "reason": "現物損切り(-10%)到達"}
            elif pl >= 20:
                result = {"type": "SELL", "label": "TAKE PROFIT (Target 2)", "reason": "第2利確(+20%)到達"}
            elif pl >= 12:
                result = {"type": "SELL", "label": "TAKE PROFIT (Target 1)", "reason": "第1利確(+12%)到達"}

            if days_held > CONFIG["LIMIT_MARGIN_DAYS"]:
                result = {"type": "SELL", "label": "TIME LIMIT", "reason": f"保有期限超過 ({days_held}営業日)"}

    if result:
        is_ignored = any(
            s.get("ticker") == asset.get("Ticker") and s.get("signalType") == result["label"]
            for s in ignored_signals
        )
        if is_ignored:
            return None

    return result


def load_storage() -> Dict[str, Any]:
    if not os.path.exists(STORAGE_PATH):
        return {"assets": [], "logs": [], "ignored": []}

    with open(STORAGE_PATH, "r", encoding="utf-8") as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError:
            return {"assets": [], "logs": [], "ignored": []}

    return {
        "assets": data.get("assets", []),
        "logs": data.get("logs", []),
        "ignored": data.get("ignored", []),
    }


def save_storage(assets: List[Dict[str, Any]], logs: List[Dict[str, Any]], ignored: List[Dict[str, str]]) -> None:
    os.makedirs(os.path.dirname(STORAGE_PATH), exist_ok=True)
    payload = {"assets": assets, "logs": logs, "ignored": ignored}

    dir_name = os.path.dirname(STORAGE_PATH)
    with tempfile.NamedTemporaryFile("w", delete=False, dir=dir_name, encoding="utf-8") as tmp:
        json.dump(payload, tmp, ensure_ascii=False, indent=2)
        tmp_path = tmp.name

    os.replace(tmp_path, STORAGE_PATH)


def get_auth_credentials() -> Dict[str, str]:
    username = None
    password = None
    cookie_key = None

    if "auth" in st.secrets:
        auth = st.secrets["auth"]
        username = auth.get("username")
        password = auth.get("password")
        cookie_key = auth.get("cookie_key")

    if not username:
        username = os.getenv("APP_USERNAME")
    if not password:
        password = os.getenv("APP_PASSWORD")
    if not cookie_key:
        cookie_key = os.getenv("APP_COOKIE_KEY")

    if not username or not password:
        username = "admin"
        password = "admin"
        st.sidebar.warning("認証がデフォルト(admin/admin)です。Secretsで変更してください。")

    if not cookie_key:
        cookie_key = "change-me"
        st.sidebar.warning("cookie_keyが未設定です。Secretsで変更してください。")

    return {
        "username": str(username),
        "password": str(password),
        "cookie_key": str(cookie_key),
    }


def build_authenticator(creds: Dict[str, str]) -> stauth.Authenticate:
    passwords = [creds["password"]]
    try:
        from streamlit_authenticator.utilities.hasher import Hasher

        hashed_passwords = Hasher(passwords).generate()
    except Exception:
        try:
            import bcrypt

            hashed_passwords = [
                bcrypt.hashpw(passwords[0].encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
            ]
        except Exception as exc:
            raise RuntimeError("Password hashing failed; check streamlit-authenticator/bcrypt.") from exc

    credentials = {
        "usernames": {
            creds["username"]: {
                "name": "User",
                "password": hashed_passwords[0],
            }
        }
    }
    try:
        return stauth.Authenticate(
            credentials,
            "trading-operations-auth",
            creds["cookie_key"],
            cookie_expiry_days=7,
        )
    except TypeError:
        return stauth.Authenticate(
            ["User"],
            [creds["username"]],
            hashed_passwords,
            "trading-operations-auth",
            creds["cookie_key"],
            cookie_expiry_days=7,
        )


def run_login(authenticator: stauth.Authenticate):
    try:
        result = authenticator.login(location="sidebar")
    except TypeError:
        result = authenticator.login("ログイン", "sidebar")

    if isinstance(result, tuple):
        if len(result) == 3:
            return result
        if len(result) == 2:
            return result[0], result[1], None
        if len(result) == 1:
            return result[0], None, None
    if isinstance(result, dict):
        return (
            result.get("name"),
            result.get("authentication_status"),
            result.get("username"),
        )
    # Fallback for versions that only set session_state.
    return (
        st.session_state.get("name"),
        st.session_state.get("authentication_status"),
        st.session_state.get("username"),
    )


def run_logout(authenticator: stauth.Authenticate) -> None:
    try:
        authenticator.logout(location="sidebar")
    except TypeError:
        authenticator.logout("ログアウト", "sidebar")


def add_log(logs: List[Dict[str, Any]], ticker: str, action: str, log_type: str, reason: str = "") -> None:
    logs.insert(
        0,
        {
            "date": datetime.now().strftime("%Y/%m/%d %H:%M:%S"),
            "ticker": ticker,
            "action": action,
            "type": log_type,
            "reason": reason,
        },
    )


def parse_optional_float(value: str) -> Optional[float]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def add_log_detail(logs: List[Dict[str, Any]], detail: Dict[str, Any]) -> None:
    if not logs:
        return
    logs[0].update(detail)


def calculate_compliance(logs: List[Dict[str, Any]]) -> int:
    if not logs:
        return 100
    compliance_flags = [l.get("rule_compliance") for l in logs if l.get("rule_compliance") is not None]
    if compliance_flags:
        compliant = sum(1 for v in compliance_flags if v)
        return round((compliant / len(compliance_flags)) * 100)
    executed = sum(1 for l in logs if l.get("type") == "EXECUTE")
    return round((executed / len(logs)) * 100)


def calculate_avg_pl(logs: List[Dict[str, Any]]) -> Optional[float]:
    values = [l.get("result_pl_pct") for l in logs if l.get("result_pl_pct") is not None]
    if not values:
        return None
    return sum(values) / len(values)


st.set_page_config(page_title="投資運用支援", layout="wide")
creds = get_auth_credentials()
authenticator = build_authenticator(creds)
name, auth_status, _ = run_login(authenticator)
if auth_status is False:
    st.sidebar.error("IDまたはパスワードが違います")
    st.stop()
if auth_status is None:
    st.sidebar.info("ログインしてください")
    st.stop()

with st.sidebar:
    run_logout(authenticator)
    st.subheader("ルール設定")
    index_trend = st.selectbox("指数トレンド", ["Up", "Range", "Down"], index=1)
    st.divider()
    st.subheader("ログ入力")
    st.text_input("エントリー理由", key="log_entry_reason")
    st.text_input("想定シナリオ", key="log_scenario")
    st.text_input("結果(損益%)", key="log_pl_pct")
    st.checkbox("ルール遵守", value=True, key="log_compliance")

storage = load_storage()
assets = normalize_assets(storage["assets"])
logs = storage["logs"]
ignored = storage["ignored"]

st.title("投資運用支援システム")

with st.expander("CSV入力/更新", expanded=False):
    uploaded = st.file_uploader("CSVファイル", type=["csv"])
    csv_default = assets_to_csv(assets) if assets else get_test_csv()
    csv_text = st.text_area("CSVテキスト", value=csv_default, height=200)
    if st.button("データを更新"):
        text = csv_text
        if uploaded is not None:
            text = uploaded.getvalue().decode("utf-8")
        new_assets = parse_csv(text)
        assets = normalize_assets(merge_assets(assets, new_assets))
        save_storage(assets, logs, ignored)
        st.success("データを追加更新しました")

if not assets:
    st.info("データがありません。CSVを入力して更新してください。")
    st.stop()

stats = calculate_stats(assets, index_trend)
avg_pl = calculate_avg_pl(logs)

col1, col2, col3, col4 = st.columns(4)
col1.metric("総資産", f"\u00a5{stats['total_value']:,.0f}")
col2.metric("DD", f"{stats['dd_pct']:.2f}%")
col3.metric("コンプライアンス", f"{calculate_compliance(logs)}%")
col4.metric("損益率(平均)", "-" if avg_pl is None else f"{avg_pl:.2f}%")

st.subheader("アロケーション")
alloc_values = [
    stats["allocation"]["Reserve"],
    stats["allocation"]["Long"],
    stats["allocation"]["Medium"],
]
alloc_labels = ["Reserve", "Long", "Medium"]
total_alloc = sum(alloc_values) if sum(alloc_values) else 1
alloc_ratios = [v / total_alloc * 100 for v in alloc_values]
alloc_display = [
    f"{label}\n¥{value:,.0f}\n{ratio:.1f}%"
    for label, value, ratio in zip(alloc_labels, alloc_values, alloc_ratios)
]

fig, ax = plt.subplots(figsize=(4, 4))
ax.pie(
    alloc_values,
    labels=alloc_display,
    startangle=90,
    counterclock=False,
    wedgeprops={"width": 0.45, "edgecolor": "white"},
)
ax.set_aspect("equal")
st.pyplot(fig, use_container_width=False)

if stats["alerts"]:
    st.subheader("アラート")
    for alert in stats["alerts"]:
        st.warning(f"[{alert['level']}] {alert['msg']}")

st.subheader("銘柄一覧")
asset_df = pd.DataFrame(assets)
asset_df.insert(
    4,
    "Days",
    asset_df.get("TradeDate", pd.Series()).apply(
        lambda d: calculate_business_days(d) if isinstance(d, str) else 0
    ),
)
if "TradeDate" in asset_df.columns:
    asset_df["TradeDate"] = pd.to_datetime(asset_df["TradeDate"], errors="coerce").dt.date

edited_df = st.data_editor(
    asset_df,
    column_config={
        "TradeDate": st.column_config.DateColumn("TradeDate"),
        "Days": st.column_config.NumberColumn("Days", disabled=True),
        "Portfolio": st.column_config.SelectboxColumn("Portfolio", options=["Reserve", "Long", "Medium"]),
        "Type": st.column_config.SelectboxColumn("Type", options=["Cash", "Stock", "MarginLong", "MarginShort"]),
        "Trend_Day": st.column_config.SelectboxColumn("Trend_Day", options=["Up", "Range", "Down"]),
        "Country": st.column_config.SelectboxColumn("Country", options=["JP", "US", "Other"]),
        "Event": st.column_config.SelectboxColumn(
            "Event",
            options=["None", "EarningsUpcoming", "Earnings", "Policy", "Industry"],
        ),
    },
    use_container_width=True,
    num_rows="dynamic",
)

updated_assets: List[Dict[str, Any]] = []
for record in edited_df.to_dict("records"):
    record.pop("Days", None)
    trade_date = record.get("TradeDate")
    if isinstance(trade_date, date):
        record["TradeDate"] = trade_date.isoformat()
    elif trade_date is None:
        record["TradeDate"] = ""
    updated_assets.append(record)

if updated_assets != assets:
    assets = updated_assets
    save_storage(assets, logs, ignored)

st.subheader("アクション必要")
signal_count = 0
for asset in assets:
    signal = generate_signal(asset, ignored, index_trend)
    if not signal:
        continue
    signal_count += 1

    with st.container():
        cols = st.columns([3, 1, 1])
        cols[0].markdown(
            f"**{asset.get('Ticker')}** ({asset.get('Name')})  \n"
            f"{signal['label']}  \n"
            f"理由: {signal['reason']}"
        )
        if cols[1].button("実行記録", key=f"exec-{asset.get('Ticker')}-{signal['label']}"):
            add_log(logs, asset.get("Ticker"), signal["label"], "EXECUTE")
            add_log_detail(
                logs,
                {
                    "entry_reason": st.session_state.get("log_entry_reason", ""),
                    "scenario": st.session_state.get("log_scenario", ""),
                    "result_pl_pct": parse_optional_float(st.session_state.get("log_pl_pct", "")),
                    "rule_compliance": st.session_state.get("log_compliance", True),
                },
            )
            save_storage(assets, logs, ignored)
            st.rerun()
        if cols[2].button("無視", key=f"ignore-{asset.get('Ticker')}-{signal['label']}"):
            ignored.append({"ticker": asset.get("Ticker"), "signalType": signal["label"]})
            add_log(logs, asset.get("Ticker"), "IGNORE", "IGNORE", "")
            add_log_detail(
                logs,
                {
                    "entry_reason": st.session_state.get("log_entry_reason", ""),
                    "scenario": st.session_state.get("log_scenario", ""),
                    "result_pl_pct": parse_optional_float(st.session_state.get("log_pl_pct", "")),
                    "rule_compliance": st.session_state.get("log_compliance", True),
                },
            )
            save_storage(assets, logs, ignored)
            st.rerun()

if signal_count == 0:
    st.success("アクション対象はありません")

if st.button("無視リストをリセット"):
    ignored = []
    save_storage(assets, logs, ignored)
    st.success("無視リストをリセットしました")

st.subheader("ログ")
if logs:
    log_df = pd.DataFrame(logs)
    st.dataframe(log_df, use_container_width=True)
else:
    st.info("ログはまだありません")

if st.button("データを全て消去"):
    assets = []
    logs = []
    ignored = []
    save_storage(assets, logs, ignored)
    st.success("データを消去しました")
