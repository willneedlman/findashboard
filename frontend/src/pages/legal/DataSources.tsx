import LegalPage, { Section, P, UL } from './LegalPage'

export default function DataSources() {
  return (
    <LegalPage title="Data Sources" lastUpdated="June 2026">
      <Section title="Market Data">
        <P><strong>Yahoo Finance (via yfinance open-source library)</strong></P>
        <UL items={[
          'Price history, OHLCV data, options chains, earnings dates',
          'Data is sourced from Yahoo Finance and subject to Yahoo\'s terms of service',
          'May be delayed 15–20 minutes for real-time quotes',
          'https://finance.yahoo.com',
        ]} />
      </Section>

      <Section title="Fundamental Data">
        <P><strong>Financial Modeling Prep (FMP)</strong></P>
        <UL items={[
          'Income statements, balance sheets, cash flow statements',
          'Analyst estimates, consensus ratings, price targets',
          'Real-time quotes and market cap data',
          'FMP API key required for full functionality — some features degrade gracefully without it',
          'https://financialmodelingprep.com',
        ]} />
      </Section>

      <Section title="Interest Rate Data">
        <P><strong>Federal Reserve Bank of St. Louis (FRED)</strong></P>
        <UL items={[
          'Federal Funds Rate (DTB3 series)',
          'Data is official U.S. Federal Reserve data and is publicly available',
          'https://fred.stlouisfed.org',
        ]} />
        <P><strong>Yahoo Finance (via yfinance)</strong></P>
        <UL items={[
          'Treasury yield data (^IRX, ^FVX, ^TNX, ^TYX)',
          '1Y, 5Y, 10Y, 30Y Treasury yields',
        ]} />
      </Section>

      <Section title="Chart Widgets">
        <P><strong>TradingView</strong></P>
        <UL items={[
          'Advanced chart embeds via TradingView\'s free widget API',
          'TradingView branding is displayed as required by their free-tier terms',
          'Chart data is served directly from TradingView\'s infrastructure',
          'Removal of TradingView branding requires a paid TradingView plan',
          'https://www.tradingview.com',
        ]} />
      </Section>

      <Section title="Company Logos">
        <P><strong>Parqet Logo CDN</strong></P>
        <UL items={[
          'Company logos are sourced from assets.parqet.com',
          'Used for visual identification purposes only',
          'Logos are trademarks of their respective companies',
        ]} />
      </Section>

      <Section title="Data Limitations">
        <P>All data providers may experience outages, rate limiting, or data gaps. Where primary data is unavailable, the Platform may display backstop/fallback values or N/A. Users should always verify critical data against their primary broker or a licensed data vendor before making trading decisions.</P>
        <P>Cryptocurrency data (e.g., BTC-USD) is sourced from Yahoo Finance and may differ from exchange-specific prices due to the fragmented nature of crypto markets.</P>
      </Section>
    </LegalPage>
  )
}
