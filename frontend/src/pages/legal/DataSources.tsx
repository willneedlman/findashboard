import LegalPage, { Section, UL } from './LegalPage'

export default function DataSources() {
  return (
    <LegalPage title="Data Sources" lastUpdated="July 2026">
      <Section title="Prices and market data">
        <UL items={[
          'Yahoo Finance (yfinance)',
          'Alpaca (IEX)',
          'Alpha Vantage',
          'Financial Modeling Prep (FMP)',
          'Finnhub',
          'Nasdaq',
          'CoinGecko',
          'Binance.US',
        ]} />
      </Section>

      <Section title="Fundamentals and filings">
        <UL items={[
          'SEC EDGAR',
          'Financial Modeling Prep (FMP)',
          'Aswath Damodaran industry dataset',
        ]} />
      </Section>

      <Section title="Rates, macro, and economic data">
        <UL items={[
          'Federal Reserve Bank of St. Louis (FRED)',
          'US Treasury',
          'Federal Reserve',
          'Bureau of Labor Statistics (BLS)',
          'Bureau of Economic Analysis (BEA)',
          'US Census Bureau',
          'European Central Bank (ECB)',
        ]} />
      </Section>

      <Section title="Options">
        <UL items={[
          'Yahoo Finance (option chains)',
        ]} />
      </Section>

      <Section title="Fixed income and bonds">
        <UL items={[
          'OpenFIGI',
          'SEC EDGAR',
          'US Treasury',
          'SSGA (State Street)',
          'Alpha Vantage',
          'FINRA TRACE',
        ]} />
      </Section>

      <Section title="Geo-Logistics and maritime">
        <UL items={[
          'IMF PortWatch',
          'aisstream.io',
          'VesselAPI',
          'Kystverket',
          'OpenSky Network',
          'World Bank (LSCI)',
          'Drewry',
          'US Census Bureau',
          'Natural Earth',
          'Global Energy Monitor',
          'NGA World Port Index',
          'OpenStreetMap (Overpass)',
          'HELCOM',
        ]} />
      </Section>

      <Section title="News and sentiment">
        <UL items={[
          'MarketWatch, CNBC, WSJ, NYT, Financial Times, The Economist',
          'BBC, The Guardian, Yahoo Finance, Axios, Nasdaq, CoinDesk',
          'Reuters and AP (via Google News)',
          'Federal Reserve, SEC, and ECB press feeds',
          'Reddit',
          'Finnhub',
          'Groq and Cerebras (LLM correction)',
        ]} />
      </Section>

      <Section title="Charts and logos">
        <UL items={[
          'lightweight-charts',
          'Recharts',
          'TradingView',
          'logo.dev',
          'Parqet',
        ]} />
      </Section>
    </LegalPage>
  )
}
