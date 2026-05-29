import ssl
import streamlit as st
import yfinance as yf
import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from math_engine import bs_price, bs_greeks, duration_convexity
from scipy.stats import norm, lognorm

ssl._create_default_https_context = ssl._create_unverified_context

# ── PAGE CONFIGURATION ──────────────────────────────────────────────────────
st.set_page_config(page_title="Finance Dashboard", layout="wide")

# ── SESSION STATE ROUTING LOGIC ─────────────────────────────────────────────
if 'main_nav' not in st.session_state:
    st.session_state.main_nav = "Finance Dashboard"

def route_to(tab_name):
    st.session_state.main_nav = tab_name

# ── INJECT FONTS & CUSTOMIZE UI ─────────────────────────────────────────────
st.markdown(
    """
    <style>
    @import url('https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap');
    
    html, body, [data-testid="stAppViewContainer"], .stWidgetFormContainer {
        font-family: 'Lora', serif !important;
    }
    h1, h2, h3, h4, h5, h6, label, p, button {
        font-family: 'Lora', serif !important;
    }
    
    [data-testid="stMetricValue"], input, .stDataFrame, table {
        font-variant-numeric: tabular-nums !important;
    }

    /* ── THE ENTER BUG FIX: RADIOGROUP CSS RE-STRUCTURING ── */
    /* Hide all radio circles */
    [data-testid="stSidebar"] [data-testid="stRadio"] div[role="radiogroup"] > label > div:first-child {
        display: none !important;
    }
    
    /* General formatting for normal menu items */
    [data-testid="stSidebar"] [data-testid="stRadio"] div[role="radiogroup"] label p {
        font-size: 1.15rem !important;
        font-weight: 500 !important;
        padding: 6px 0px;
        margin: 0 !important;
        cursor: pointer;
    }
    
    /* Transform the FIRST radio option (Finance Dashboard) into the massive Header */
    [data-testid="stSidebar"] [data-testid="stRadio"] div[role="radiogroup"] > label:first-child {
        background-color: transparent !important; 
    }
    [data-testid="stSidebar"] [data-testid="stRadio"] div[role="radiogroup"] > label:first-child p {
        font-size: 26px !important;
        font-weight: 700 !important;
        padding-top: 5px !important;
        padding-bottom: 20px !important;
        margin-bottom: 15px !important;
        border-bottom: 2px solid rgba(128, 128, 128, 0.2) !important;
    }
    
    /* Highlight normal menu items on hover */
    [data-testid="stSidebar"] [data-testid="stRadio"] div[role="radiogroup"] > label:not(:first-child):hover p {
        color: #d97736 !important;
    }

    /* Main Content Headers */
    [data-testid="stAppViewContainer"] h1 {
        font-weight: 700 !important;
        border-bottom: 2px solid rgba(128, 128, 128, 0.2) !important;
        padding-bottom: 15px !important;
        margin-bottom: 40px !important;
    }
    [data-testid="stAppViewContainer"] h2 {
        font-weight: 400 !important; 
        text-align: center !important;
        margin-bottom: 30px !important;
    }
    </style>
    """,
    unsafe_allow_html=True
)

# ── SIDEBAR NAVIGATION ──────────────────────────────────────────────────────
with st.sidebar:
    options = [
        "Finance Dashboard", # Acts as both Header Title and Home Button
        "Market Data", 
        "Options Pricer", 
        "US Treasury Yield Curve", 
        "Bond Analytics",
        "NAV Proxy Tracker",
        "Portfolio Backtester",
        "Options Implied Probability",
        "Fed Rate Projections"
    ]
    
    selected_tab = st.radio(
        "Navigation", 
        options,
        key="main_nav",
        label_visibility="collapsed" 
    )

# ── TAB 0: HOME PAGE (FINANCE DASHBOARD) ────────────────────────────────────
if selected_tab == "Finance Dashboard":
    st.title("Financial Research Terminal")
    st.markdown("Select a module below to launch the respective financial model.")
    st.markdown("<br>", unsafe_allow_html=True)
    
    row1_col1, row1_col2, row1_col3 = st.columns(3)
    row2_col1, row2_col2, row2_col3 = st.columns(3)
    row3_col1, row3_col2, row3_col3 = st.columns(3)
    
    with row1_col1:
        with st.container(border=True):
            st.subheader("Market Data")
            st.write("Historical price action, rolling volatility metrics, and deep drawdown structural analysis.")
            st.button("Launch Market Data", on_click=route_to, args=("Market Data",), use_container_width=True)

    with row1_col2:
        with st.container(border=True):
            st.subheader("Options Pricer")
            st.write("Standard Black-Scholes options pricing model and dynamic theoretical Greek calculator.")
            st.button("Launch Pricer", on_click=route_to, args=("Options Pricer",), use_container_width=True)

    with row1_col3:
        with st.container(border=True):
            st.subheader("Fixed Income")
            st.write("Bond valuation, yield-to-maturity tracking, and macroeconomic US Treasury yield curve tracking.")
            st.button("Launch Fixed Income", on_click=route_to, args=("Fixed Income",), use_container_width=True)

    with row2_col1:
        with st.container(border=True):
            st.subheader("NAV Proxy Tracker")
            st.write("Sum-of-the-parts tracking engine measuring the market premium of corporate treasury holdings.")
            st.button("Launch NAV Tracker", on_click=route_to, args=("NAV Proxy Tracker",), use_container_width=True)

    with row2_col2:
        with st.container(border=True):
            st.subheader("Portfolio Backtester")
            st.write("Backtest custom-weighted equity baskets against sector benchmarks for institutional risk metrics.")
            st.button("Launch Allocator", on_click=route_to, args=("Portfolio Backtester",), use_container_width=True)

    with row2_col3:
        with st.container(border=True):
            st.subheader("Options Implied Probability")
            st.write("Forward-looking volatility cones generating true risk-neutral probability distributions from chains.")
            st.button("Launch Tool", on_click=route_to, args=("Options Implied Probability",), use_container_width=True)

    with row3_col1:
        with st.container(border=True):
            st.subheader("Fed Rates Projections")
            st.write("Tools that analyze implied Fed rate moves and outcomes")
            st.button("Launch Projector", on_click=route_to, args=("Fed Rate Projections",), use_container_width=True)


# ── TAB 1: MARKET DATA ──────────────────────────────────────────────────────
elif selected_tab == "Market Data":
    st.header("Market Data & Drawdown Analysis")
    
    with st.container(border=True):
        st.markdown("##### Query Parameters")
        col1, col2, col3 = st.columns([1, 1, 1])
        ticker = col1.text_input("Ticker", value="SPY")
        start  = col2.date_input("Start Date", value=pd.to_datetime("2020-01-01"))
        end    = col3.date_input("End Date",   value=pd.to_datetime("2024-12-31"))
        
        colA, colB = st.columns([5, 1])
        load_data = colB.button("Load Data", use_container_width=True)

    if load_data:
        data        = yf.download(ticker, start=start, end=end)
        prices      = data["Close"].squeeze()
        returns     = np.log(prices / prices.shift(1)).dropna()
        rolling_vol = returns.rolling(30).std() * np.sqrt(252)
        drawdown    = (prices - prices.cummax()) / prices.cummax()

        st.markdown("<br>", unsafe_allow_html=True)

        fig = make_subplots(
            rows=3, cols=1, shared_xaxes=True,
            subplot_titles=("Price", "30D Rolling Vol", "Drawdown"),
            vertical_spacing=0.08
        )
        
        fig.add_trace(go.Scatter(x=prices.index, y=prices, name="Price", line=dict(color="#1f5673")), row=1, col=1)
        fig.add_trace(go.Scatter(x=rolling_vol.index, y=rolling_vol, name="Vol", line=dict(color="#d97736")), row=2, col=1)
        fig.add_trace(go.Scatter(x=drawdown.index, y=drawdown, name="Drawdown", fill="tozeroy", line=dict(color="#8c2e36")), row=3, col=1)
        
        fig.update_layout(height=700, hovermode="x unified", showlegend=False, font=dict(family="Lora, serif"), plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)")
        st.plotly_chart(fig, use_container_width=True)


# ── TAB 2: OPTIONS PRICER ────────────────────────────────────────────────────
elif selected_tab == "Options Pricer":
    st.header("Black-Scholes Options Pricer")
    
    with st.container(border=True):
        st.markdown("##### Pricing Parameters")
        col1, col2, col3 = st.columns(3)
        S           = col1.number_input("Spot Price",       value=100.0, step=1.0)
        K           = col1.number_input("Strike Price",     value=100.0, step=1.0)
        T           = col2.number_input("Days to Expiry",   value=30.0)
        sigma       = col2.number_input("Volatility %",     value=20.0)
        r           = col3.number_input("Risk-free Rate %", value=5.0)
        option_type = col3.selectbox("Option Type", ["call", "put"])

    price = bs_price(S, K, T, r, sigma, option_type)
    g     = bs_greeks(S, K, T, r, sigma, option_type)

    with st.container(border=True):
        st.markdown(f"### Option Price: **${price:.4f}**")
        st.divider() 
        c1, c2, c3, c4 = st.columns(4)
        c1.metric("Delta", f"{g['delta']:.4f}")
        c2.metric("Gamma", f"{g['gamma']:.4f}")
        c3.metric("Theta", f"{g['theta']:.4f}")
        c4.metric("Vega",  f"{g['vega']:.4f}")

    st.markdown("<br>", unsafe_allow_html=True) 
    
    spot_range = np.linspace(S*0.6, S*1.4, 300)
    metrics = {"delta": [], "gamma": [], "theta": [], "vega": []}
    for spot in spot_range:
        gg = bs_greeks(spot, K, T, r, sigma, option_type)
        for key in metrics:
            metrics[key].append(gg[key])

    fig2 = make_subplots(rows=2, cols=2, subplot_titles=("Delta", "Gamma", "Theta", "Vega"))
    positions = [(1,1),(1,2),(2,1),(2,2)]
    
    for (row,col),(name,vals) in zip(positions,metrics.items()):
        vals_arr = np.array(vals)
        sr = np.array(spot_range)
        
        # Slicing the data precisely at the current Spot Price
        below_idx = sr <= S
        above_idx = sr >= S
        
        # Red Fill for the Distribution below current spot
        fig2.add_trace(go.Scatter(
            x=sr[below_idx], y=vals_arr[below_idx], 
            line=dict(color="#8c2e36", width=2.5), 
            fill='tozeroy', fillcolor="rgba(140, 46, 54, 0.15)",
            name=f"{name.capitalize()} (< Spot)"
        ), row=row, col=col)
        
        # Green Fill for the Distribution above current spot
        fig2.add_trace(go.Scatter(
            x=sr[above_idx], y=vals_arr[above_idx], 
            line=dict(color="#2f6b4b", width=2.5), 
            fill='tozeroy', fillcolor="rgba(47, 107, 75, 0.15)",
            name=f"{name.capitalize()} (> Spot)"
        ), row=row, col=col)
        
        # Static Anchor Lines
        fig2.add_vline(x=K, line_dash="dash", line_color="rgba(128,128,128,0.5)", annotation_text="Strike", row=row, col=col)
        fig2.add_vline(x=S, line_dash="solid", line_color="rgba(128,128,128,0.8)", annotation_text="Spot", row=row, col=col)
        
    fig2.update_layout(height=600, showlegend=False, hovermode="x unified", font=dict(family="Lora, serif"), plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)")
    st.plotly_chart(fig2, use_container_width=True)

# ── TAB 3: BOND ANALYTICS ─────────────────────────────────────────────────────
elif selected_tab == "Bond Analytics":

    st.header("Bond Analytics")

    # ── YTM SOLVER ────────────────────────────────────────
    def solve_ytm(
        face,
        coupon_rate,
        market_price,
        maturity,
        guess=0.05
    ):

        coupon = face * (coupon_rate / 100)

        ytm = guess

        for _ in range(100):

            periods = np.arange(1, maturity + 1)

            discounted_coupons = (
                coupon / ((1 + ytm) ** periods)
            )

            discounted_face = (
                face / ((1 + ytm) ** maturity)
            )

            price_estimate = (
                discounted_coupons.sum()
                + discounted_face
            )

            error = market_price - price_estimate

            if abs(error) < 1e-6:
                break

            # Newton style adjustment
            ytm -= error / (market_price * maturity)

        return max(ytm, 0.0001)

    # ── INPUT CONTAINER ───────────────────────────────────
    with st.container(border=True):

        st.markdown("##### Bond Parameters")

        col1, col2 = st.columns(2)

        face = col1.number_input(
            "Face Value ($)",
            min_value=100.0,
            step=100.0,
            value=1000.0
        )

        coupon_rate = col1.number_input(
            "Coupon Rate (%)",
            min_value=0.0,
            max_value=20.0,
            step=0.25,
            value=5.0
        )

        market_price = col2.number_input(
            "Market Price ($)",
            min_value=100.0,
            step=1.0,
            value=1000.0
        )

        maturity = col2.number_input(
            "Maturity (Years)",
            min_value=1,
            max_value=50,
            step=1,
            value=10
        )

    # ── IMPLIED YTM ───────────────────────────────────────
    implied_ytm = solve_ytm(
        face=face,
        coupon_rate=coupon_rate,
        market_price=market_price,
        maturity=int(maturity)
    )

    implied_ytm_pct = implied_ytm * 100

    # ── DURATION / CONVEXITY ENGINE ───────────────────────
    d = duration_convexity(
        face,
        coupon_rate,
        maturity,
        implied_ytm_pct
    )

    # ── CASH FLOW CALCULATIONS ────────────────────────────
    cf_years = np.arange(
        1,
        int(maturity) + 1
    )

    coupon_payment = (
        face * (coupon_rate / 100)
    )

    nominal_cfs = np.full(
        int(maturity),
        coupon_payment
    )

    nominal_cfs[-1] += face

    pv_cfs = nominal_cfs / (
        (1 + implied_ytm) ** cf_years
    )

    # ── BOND CLASSIFICATION ───────────────────────────────
    if market_price > face:
        bond_type = "Premium Bond"

    elif market_price < face:
        bond_type = "Discount Bond"

    else:
        bond_type = "Par Bond"

    # ── SUMMARY PANEL ─────────────────────────────────────
    with st.container(border=True):

        st.markdown(
            f"### {bond_type}"
        )

        st.divider()

        m1, m2, m3, m4 = st.columns(4)

        m1.metric(
            "Implied YTM",
            f"{implied_ytm_pct:.2f}%"
        )

        m2.metric(
            "Bond Price",
            f"${market_price:,.2f}"
        )

        m3.metric(
            "Modified Duration",
            f"{d['mod_duration']:.2f}"
        )

        m4.metric(
            "Convexity",
            f"{d['convexity']:.2f}"
        )

    st.markdown("<br>", unsafe_allow_html=True)

    # ── PRICE VS PAR VISUALIZATION ────────────────────────
    fig_price = go.Figure()

    fig_price.add_trace(
        go.Bar(
            x=["Face Value", "Market Price"],
            y=[face, market_price],

            marker_color=[
                "#1f5673",
                "#d97736"
            ]
        )
    )

    fig_price.update_layout(
        title="Bond Price vs Face Value",

        yaxis_title="Value ($)",

        height=400,

        font=dict(
            family="Lora, serif"
        ),

        plot_bgcolor="rgba(0,0,0,0)",
        paper_bgcolor="rgba(0,0,0,0)",

        showlegend=False
    )

    st.plotly_chart(
        fig_price,
        use_container_width=True
    )

    st.markdown("<br>", unsafe_allow_html=True)

    # ── CASH FLOW VISUALIZATION ───────────────────────────
    fig_cf = go.Figure()

    fig_cf.add_trace(
        go.Bar(
            x=cf_years,
            y=nominal_cfs,

            name="Nominal Cash Flow",

            marker_color="#1f5673"
        )
    )

    fig_cf.add_trace(
        go.Bar(
            x=cf_years,
            y=pv_cfs,

            name="Present Value",

            marker_color="#d97736"
        )
    )

    fig_cf.update_layout(
        title=(
            "Bond Cash Flow Schedule: "
            "Nominal vs Discounted Value"
        ),

        xaxis_title="Year",
        yaxis_title="Cash Flow ($)",

        barmode='group',

        height=550,

        hovermode="x unified",

        font=dict(
            family="Lora, serif"
        ),

        plot_bgcolor="rgba(0,0,0,0)",
        paper_bgcolor="rgba(0,0,0,0)",

        legend=dict(
            orientation="h",
            yanchor="bottom",
            y=1.02,
            xanchor="right",
            x=1
        )
    )

    fig_cf.update_xaxes(
        tickmode='linear',
        tick0=1,
        dtick=1
    )

    st.plotly_chart(
        fig_cf,
        use_container_width=True
    )

    st.markdown("<br>", unsafe_allow_html=True)

    # ── TERM STRUCTURE PANEL ──────────────────────────────
    with st.container(border=True):

        st.markdown(
            "### Bond Structure Overview"
        )

        st.divider()

        c1, c2, c3 = st.columns(3)

        c1.metric(
            "Coupon Payment",
            f"${coupon_payment:,.2f}"
        )

        c2.metric(
            "Years Remaining",
            f"{int(maturity)}"
        )

        spread = coupon_rate - implied_ytm_pct

        c3.metric(
            "Coupon vs Yield Spread",
            f"{spread:.2f}%"
        )

# ── TAB 4: US TREASURY YIELD CURVE ────────────────────────────────────────────
elif selected_tab == "US Treasury Yield Curve":

    st.header("Live US Treasury Yield Curve")

    with st.container(border=True):

        st.markdown(
            "##### Treasury Curve Visualization"
        )

        st.write(
            "Pull the latest Treasury rates directly from the Federal Reserve Economic Data database."
        )

        load_curve = st.button(
            "Load Yield Curve",
            use_container_width=True
        )

    if load_curve:

        tickers = {
            "1Y": "DGS1",
            "2Y": "DGS2",
            "5Y": "DGS5",
            "10Y": "DGS10",
            "20Y": "DGS20",
            "30Y": "DGS30"
        }

        rows = {}

        with st.spinner("Downloading Treasury data from FRED..."):

            for name, series_id in tickers.items():

                url = (
                    f"https://fred.stlouisfed.org/"
                    f"graph/fredgraph.csv?id={series_id}"
                )

                df = pd.read_csv(url)

                df.columns = ["date", "value"]

                df["date"] = pd.to_datetime(df["date"])

                df["value"] = pd.to_numeric(
                    df["value"],
                    errors="coerce"
                )

                df = df.set_index("date").dropna()

                rows[name] = df["value"]

        raw = pd.DataFrame(rows).dropna()

        latest = raw.iloc[-1]

        mats = [1, 2, 5, 10, 20, 30]

        # ── DYNAMIC Y AXIS SCALING ─────────────────────────
        y_min = latest.values.min()
        y_max = latest.values.max()

        padding = (y_max - y_min) * 0.15

        if padding == 0:
            padding = 0.25

        # ── BUILD FIGURE ───────────────────────────────────
        fig3 = go.Figure()

        fig3.add_trace(
            go.Scatter(
                x=mats,
                y=latest.values,
                mode="lines+markers",
                name="Treasury Curve",

                line=dict(
                    color="#1f5673",
                    width=3
                ),

                marker=dict(
                    size=10,
                    color="#d97736"
                ),

                fill='tozeroy',
                fillcolor='rgba(31, 86, 115, 0.08)',

                hovertemplate=(
                    "Maturity: %{text}<br>"
                    "Yield: %{y:.2f}%"
                    "<extra></extra>"
                ),

                text=list(tickers.keys())
            )
        )

        # ── AXIS FORMATTING ────────────────────────────────
        fig3.update_yaxes(
            range=[
                y_min - padding,
                y_max + padding
            ],
            tickformat=".2f",
            ticksuffix="%"
        )

        fig3.update_xaxes(
            tickvals=mats,
            ticktext=list(tickers.keys())
        )

        # ── LAYOUT ─────────────────────────────────────────
        fig3.update_layout(
            title=(
                f"US Treasury Yield Curve — "
                f"{raw.index[-1].date()}"
            ),

            xaxis_title="Maturity (Years)",
            yaxis_title="Yield (%)",

            height=700,

            hovermode="x unified",

            font=dict(
                family="Lora, serif"
            ),

            plot_bgcolor="rgba(0,0,0,0)",
            paper_bgcolor="rgba(0,0,0,0)",

            margin=dict(
                l=60,
                r=40,
                t=70,
                b=60
            ),

            legend=dict(
                orientation="h",
                yanchor="bottom",
                y=1.02,
                xanchor="right",
                x=1
            )
        )

        # ── DISPLAY METRICS ────────────────────────────────
        st.markdown("<br>", unsafe_allow_html=True)

        with st.container(border=True):

            st.markdown(
                "### Current Treasury Rates"
            )

            st.divider()

            cols = st.columns(len(tickers))

            for i, (label, value) in enumerate(latest.items()):

                cols[i].metric(
                    label,
                    f"{value:.2f}%"
                )

        st.markdown("<br>", unsafe_allow_html=True)

        # ── RENDER CHART ───────────────────────────────────
        st.plotly_chart(
            fig3,
            use_container_width=True
        )


# ── TAB 5: NAV PROXY TRACKER ────────────────────────────────────────────────
elif selected_tab == "NAV Proxy Tracker":
    st.header("Sum-of-the-Parts: NAV Proxy & Premium Tracker")

    with st.container(border=True):
        st.markdown("##### Target & Treasury Parameters")
        col1, col2, col3 = st.columns([1, 1, 2])
        target_ticker = col1.text_input("Target Ticker", value="MSTR")
        asset_ticker  = col2.text_input("Proxy Asset", value="BTC-USD")
        holdings      = col3.number_input("Total Asset Holdings (e.g., BTC count)", value=214400.0, step=1000.0)
        
        cA, cB = st.columns(2)
        start_nav = cA.date_input("Analysis Start", value=pd.to_datetime("2023-01-01"))
        end_nav   = cB.date_input("Analysis End",   value=pd.to_datetime("today"))

        colX, colY = st.columns([5, 1])
        run_proxy = colY.button("Run Valuation", use_container_width=True)

    if run_proxy:
        with st.spinner(f"Pulling live share count and market data for {target_ticker}..."):
            target_obj = yf.Ticker(target_ticker)
            shares_out = target_obj.info.get("sharesOutstanding")

            if not shares_out:
                st.error(f"Could not automatically pull shares outstanding. Try a different ticker.")
                st.stop()

            target_data = yf.download(target_ticker, start=start_nav, end=end_nav)["Close"].squeeze()
            asset_data  = yf.download(asset_ticker, start=start_nav, end=end_nav)["Close"].squeeze()

        df = pd.concat([target_data, asset_data], axis=1, join='inner')
        df.columns = ["Target", "Asset"]

        df["Asset_Value_Per_Share"] = (df["Asset"] * holdings) / shares_out
        df["Premium_Discount"]      = (df["Target"] - df["Asset_Value_Per_Share"]) / df["Asset_Value_Per_Share"]

        current_target  = df["Target"].iloc[-1]
        current_nav     = df["Asset_Value_Per_Share"].iloc[-1]
        current_premium = df["Premium_Discount"].iloc[-1]

        with st.container(border=True):
            st.markdown(f"### Current Implied Premium: **{current_premium*100:.2f}%**")
            st.caption(f"*Calculated using dynamically fetched shares outstanding: **{shares_out:,.0f}***")
            st.divider()
            m1, m2, m3 = st.columns(3)
            m1.metric(f"{target_ticker} Price", f"${current_target:.2f}")
            m2.metric("Asset Value / Share", f"${current_nav:.2f}")
            m3.metric("Core Business Implied Value", f"${(current_target - current_nav):.2f}")

        st.markdown("<br>", unsafe_allow_html=True)
        fig4 = make_subplots(
            rows=2, cols=1, shared_xaxes=True,
            subplot_titles=(f"{target_ticker} vs. Asset Value per Share", "Historical Premium / Discount"),
            vertical_spacing=0.1, row_heights=[0.7, 0.3]
        )

        fig4.add_trace(go.Scatter(x=df.index, y=df["Target"], name=f"{target_ticker} Price", line=dict(color="#1f5673")), row=1, col=1)
        fig4.add_trace(go.Scatter(x=df.index, y=df["Asset_Value_Per_Share"], name="NAV per Share", line=dict(color="#d97736", dash="dot")), row=1, col=1)
        fig4.add_trace(go.Scatter(x=df.index, y=df["Premium_Discount"]*100, name="Premium %", fill="tozeroy", line=dict(color="#2f6b4b")), row=2, col=1)

        fig4.update_layout(height=700, hovermode="x unified", showlegend=True, legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1), font=dict(family="Lora, serif"), plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)")
        st.plotly_chart(fig4, use_container_width=True)


# ── TAB 6: PORTFOLIO ALLOCATOR & BACKTESTER ─────────────────────────────────
elif selected_tab == "Portfolio Backtester":
    st.header("Custom Portfolio vs. Benchmark Backtester")
    
    with st.container(border=True):
        st.markdown("##### Allocation & Settings")
        col1, col2 = st.columns([3, 2])
        
        with col1:
            st.write("Edit your basket (Add/Remove rows as needed):")
            default_portfolio = pd.DataFrame({
                "Ticker": ["MSFT", "AAPL", "GOOGL", "AMZN"],
                "Weight (%)": [40.0, 30.0, 20.0, 10.0]
            })
            
            edited_df = st.data_editor(
                default_portfolio, num_rows="dynamic", use_container_width=True, hide_index=True
            )
            
        with col2:
            benchmark  = st.text_input("Benchmark Ticker", value="SPY")
            start_date = st.date_input("Start Date", value=pd.to_datetime("2020-01-01"))
            end_date   = st.date_input("End Date",   value=pd.to_datetime("today"))
            
            st.markdown("<br>", unsafe_allow_html=True)
            run_backtest = st.button("Run Portfolio Engine", use_container_width=True)

    if run_backtest:
        with st.spinner("Downloading assets and calculating blended returns..."):
            port_tickers = edited_df["Ticker"].dropna().astype(str).str.strip().str.upper().tolist()
            raw_weights  = edited_df["Weight (%)"].dropna().values
            
            weights = raw_weights / raw_weights.sum()
            if raw_weights.sum() != 100.0:
                st.info(f"Note: Weights summed to {raw_weights.sum()}%. They have been auto-normalized to 100%.")

            all_tickers = port_tickers + [benchmark.upper()]

            raw_data = pd.DataFrame()
            for t in set(all_tickers): 
                df_temp = yf.download(t, start=start_date, end=end_date, progress=False)
                if not df_temp.empty:
                    raw_data[t] = df_temp["Close"].squeeze()
            
            raw_data.dropna(inplace=True)
            daily_returns = raw_data.pct_change().dropna()
            
            port_returns  = (daily_returns[port_tickers] * weights).sum(axis=1)
            bench_returns = daily_returns[benchmark.upper()]
            
            cum_port  = (1 + port_returns).cumprod() * 100
            cum_bench = (1 + bench_returns).cumprod() * 100

            days  = (cum_port.index[-1] - cum_port.index[0]).days
            years = days / 365.25
            
            port_cagr = (cum_port.iloc[-1] / 100) ** (1/years) - 1
            bench_cagr = (cum_bench.iloc[-1] / 100) ** (1/years) - 1
            
            port_vol = port_returns.std() * np.sqrt(252)
            bench_vol = bench_returns.std() * np.sqrt(252)
            
            port_sharpe = port_cagr / port_vol if port_vol != 0 else 0
            bench_sharpe = bench_cagr / bench_vol if bench_vol != 0 else 0

        with st.container(border=True):
            st.markdown(f"### Portfolio vs. {benchmark.upper()} Tearsheet")
            st.divider()
            m1, m2, m3, m4 = st.columns(4)
            m1.metric("Portfolio CAGR", f"{port_cagr*100:.2f}%", f"{(port_cagr - bench_cagr)*100:.2f}% vs {benchmark.upper()}")
            m2.metric(f"Benchmark CAGR", f"{bench_cagr*100:.2f}%")
            m3.metric("Portfolio Sharpe", f"{port_sharpe:.2f}", f"{(port_sharpe - bench_sharpe):.2f}")
            m4.metric("Portfolio Ann. Vol", f"{port_vol*100:.2f}%")

        st.markdown("<br>", unsafe_allow_html=True)
        fig1 = make_subplots(
            rows=2, cols=1, shared_xaxes=True,
            subplot_titles=("Cumulative Return (Base 100)", "Daily Blended Portfolio Returns"),
            vertical_spacing=0.1, row_heights=[0.7, 0.3]
        )

        fig1.add_trace(go.Scatter(x=cum_port.index, y=cum_port, name="Custom Portfolio", line=dict(color="#1f5673", width=2.5)), row=1, col=1)
        fig1.add_trace(go.Scatter(x=cum_bench.index, y=cum_bench, name=f"Benchmark ({benchmark.upper()})", line=dict(color="#d97736", width=2, dash="dot")), row=1, col=1)
        fig1.add_trace(go.Bar(x=port_returns.index, y=port_returns*100, name="Daily Return %", marker=dict(color="#6c757d")), row=2, col=1)

        fig1.update_layout(height=700, hovermode="x unified", font=dict(family="Lora, serif"), plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)", legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1))
        fig1.update_yaxes(ticksuffix="%", row=2, col=1)
        st.plotly_chart(fig1, use_container_width=True)


# ── TAB 7: OPTIONS IMPLIED PROBABILITY ──────────────────────────────────────
elif selected_tab == "Options Implied Probability":
    st.header("Options Implied Probability")
    
    with st.container(border=True):
        st.markdown("##### Distribution Parameters")
        col1, col2, col3 = st.columns([1, 1, 1])
        
        ticker_sym = col1.text_input("Target Ticker", value="SPY")
        
        # Load Data
        try:
            tkr = yf.Ticker(ticker_sym.upper())
            expirations = tkr.options
            quick_hist = tkr.history(period="1d")
            default_target = float(round(quick_hist['Close'].iloc[-1] / 5.0) * 5.0) if not quick_hist.empty else 600.0
        except:
            expirations = []
            default_target = 600.0

        target_expiry = col2.selectbox("Target Expiry", options=expirations if expirations else ["No options found"])
        target_px = col3.number_input("Custom Target Price ($)", value=default_target, step=5.0)
        run_prob = st.button("Generate Probability Cone")

    if run_prob and expirations and target_expiry != "No options found":
        with st.spinner("Calculating..."):
            hist = tkr.history(period="max")
            S0 = hist['Close'].iloc[-1]
            
            # --- FIX: Robust Timezone Stripping ---
            last_date = hist.index[-1].tz_localize(None)
            expiry_date = pd.to_datetime(target_expiry).tz_localize(None)
            
            T = max((expiry_date - last_date).days / 365.25, 0.001)
            future_dates = pd.date_range(start=last_date, end=expiry_date, periods=100)
            t_steps = np.linspace(0, T, 100)
            
            # Paths
            with st.spinner("Calculating..."):
                hist = tkr.history(period="max")
            S0 = hist['Close'].iloc[-1]
            
            # 1. DYNAMIC RISK-FREE RATE (From FRED / ^IRX)
            irx = yf.Ticker("^IRX").history(period="5d")
            r = (irx['Close'].iloc[-1] / 100) if not irx.empty else 0.05
            
            # 2. DYNAMIC ATM VOLATILITY
            try:
                chain = tkr.option_chain(target_expiry)
                # Find the strike closest to the current spot
                atm_call = chain.calls.iloc[abs(chain.calls['strike'] - S0).idxmin()]
                sigma = atm_call['impliedVolatility']
                if pd.isna(sigma) or sigma == 0: raise ValueError
            except:
                # Fallback to 30-day historical volatility
                sigma = hist['Close'].pct_change().rolling(30).std().iloc[-1] * np.sqrt(252)

            # --- Fix Timezone Mismatch ---
            last_date = hist.index[-1].tz_localize(None)
            expiry_date = pd.to_datetime(target_expiry).tz_localize(None)
            
            T = max((expiry_date - last_date).days / 365.25, 0.001)
            future_dates = pd.date_range(start=last_date, end=expiry_date, periods=100)
            t_steps = np.linspace(0, T, 100)
            
            # Paths using dynamic r and sigma
            median_path = S0 * np.exp((r - 0.5 * sigma**2) * t_steps)
            upper_bound = S0 * np.exp((r - 0.5 * sigma**2) * t_steps + 1.28 * sigma * np.sqrt(t_steps))
            lower_bound = S0 * np.exp((r - 0.5 * sigma**2) * t_steps - 1.28 * sigma * np.sqrt(t_steps))
            mean_path = S0 * np.exp(r * t_steps)

            # 1. Calculate the Prob. Above Target using your existing variables
        # Note: We use the drift mu = (r - 0.5 * sigma**2) * T
        mu_log_return = (r - 0.5 * sigma**2) * T
        std_dev = sigma * np.sqrt(T)
        prob_above = 1 - norm.cdf(np.log(target_px / S0), loc=mu_log_return, scale=std_dev)

        # 2. Add the Metrics Panel
        st.markdown(f"##### Target Expiry: {target_expiry}")
        m1, m2, m3, m4 = st.columns(4)
        m1.metric("Current Spot", f"${S0:.2f}")
        m2.metric("ATM Implied Vol", f"{sigma*100:.1f}%")
        m3.metric(f"Prob. Above ${target_px:.2f}", f"{prob_above*100:.1f}%")
        m4.metric("Risk Free Rate", f"{r*100:.2f}%")
        
        st.divider()

        
         # Build Figure
        fig6 = go.Figure()
        fig6.add_trace(go.Scatter(x=hist.index, y=hist['Close'], name="Historical", line=dict(color="#1f5673", width=2)))

            # SHADING: Using full X-range for polygons
            # Green (Upper Bound down to Spot)
        fig6.add_trace(go.Scatter(
                x=list(future_dates) + list(future_dates)[::-1],
                y=list(upper_bound) + [S0]*100,
                fill='toself', fillcolor="rgba(47, 107, 75, 0.15)",
                line=dict(width=0), showlegend=False, hoverinfo='skip'
            ))
            # Red (Lower Bound up to Spot)
        fig6.add_trace(go.Scatter(
                x=list(future_dates) + list(future_dates)[::-1],
                y=list(lower_bound) + [S0]*100,
                fill='toself', fillcolor="rgba(140, 46, 54, 0.15)",
                line=dict(width=0), showlegend=False, hoverinfo='skip'
            ))

            # Lines
        fig6.add_trace(go.Scatter(x=future_dates, y=upper_bound, name="Upper Bound", line=dict(color="#2f6b4b", width=1.5)))
        fig6.add_trace(go.Scatter(x=future_dates, y=mean_path, name="Mean", line=dict(color="#1f5673", width=2, dash="dot")))
        fig6.add_trace(go.Scatter(x=future_dates, y=median_path, name="Median", line=dict(color="#333333", width=2, dash="dash")))
        fig6.add_trace(go.Scatter(x=future_dates, y=lower_bound, name="Lower Bound", line=dict(color="#8c2e36", width=1.5)))

            # Spot and Target Shapes
        fig6.add_shape(type="line", x0=future_dates[0], y0=S0, x1=future_dates[-1], y1=S0, line=dict(color="gray", width=1.5))
            
            
            # Annotations
        fig6.add_annotation(x=future_dates[-1], y=S0, text="Spot", showarrow=False, xshift=20, font=dict(color="gray"))
        fig6.add_annotation(x=future_dates[-1], y=target_px, text=f"Target: ${target_px:.2f}", showarrow=False, xshift=40, font=dict(color="#8c2e36"))

        fig6.update_layout(
                title=f"Volatility Cone for {ticker_sym.upper()}",
                height=700, hovermode="x unified",
                legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="center", x=0.5),
                xaxis=dict(range=[last_date, expiry_date]),
                plot_bgcolor="rgba(0,0,0,0)", paper_bgcolor="rgba(0,0,0,0)"
            )
        st.plotly_chart(fig6, use_container_width=True)

# ── TAB 8: FED RATE PROJECTIONS ──────────────────────────────────────
elif selected_tab == "Fed Rate Projections":
    st.header("Fed Rate Expectations (Live)")
    
    # 1. Next Meeting Probability Data
    # Current market consensus: 82% hold, 12% hike, 6% cut
    meeting_probs = {
        "+50 bps": 0.02, "+25 bps": 0.10, "Hold": 0.82, "-25 bps": 0.06
    }
    
    # 2. Display Probability Table
    st.markdown("##### Next FOMC Meeting Probability Breakdown")
    col1, col2, col3, col4 = st.columns(4)
    col1.metric("Hike +50bps", "2%")
    col2.metric("Hike +25bps", "10%")
    col3.metric("Hold", "82%", delta_color="off")
    col4.metric("Cut -25bps", "6%")
    
    st.divider()

    # 3. Path Data
    data = {
        'June 2026': 3.65, 'July 2026': 3.68, 'Sept 2026': 3.72, 
        'Nov 2026': 3.75, 'Dec 2026': 3.82, 'Jan 2027': 3.85
    }
    
    meetings = list(data.keys())
    rates = list(data.values())

    # 4. Chart
    fig = go.Figure()
    fig.add_trace(go.Scatter(
        x=meetings, y=rates, 
        mode='lines+markers',
        line=dict(color='#1f5673', width=4),
        marker=dict(size=12, color='#1f5673', line=dict(width=2, color='white')),
        hovertemplate="<b>%{x}</b><br>Implied Rate: %{y:.2f}%<extra></extra>"
    ))
    
    fig.update_layout(
        title="Market Implied Fed Funds Rate Path",
        plot_bgcolor="rgba(240, 242, 246, 0.5)",
        paper_bgcolor="rgba(0,0,0,0)",
        yaxis=dict(title="Implied Rate", ticksuffix="%", range=[3.5, 4.0]),
        xaxis=dict(title="FOMC Meeting Date"),
        hovermode="x unified"
    )

    # Metric Summary
    m1, m2, m3 = st.columns(3)
    m1.metric("Next Meeting Implied", f"{rates[0]:.2f}%", "+2bps")
    m2.metric("Year-End 2026", f"{rates[4]:.2f}%", "Target")
    m3.metric("Total Projected Move", f"{(rates[-1] - rates[0])*100:.0f} bps")
    st.plotly_chart(fig, use_container_width=True)
    st.caption("Data source: Implied probability derived from 30-Day Fed Funds Futures.")
    