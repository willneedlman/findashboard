import LegalPage, { Section, P, UL } from './LegalPage'

export default function PrivacyPolicy() {
  return (
    <LegalPage title="Privacy Policy" lastUpdated="June 2026">
      <Section title="1. Overview">
        <P>Finance Terminal ("we", "us", "our") is committed to protecting your privacy. This policy describes what information we collect, how we use it, and your rights regarding that information.</P>
        <P>This platform is a personal financial analytics tool. We do not sell, rent, or share your personal data with third parties for marketing purposes.</P>
      </Section>

      <Section title="2. Information We Collect">
        <P>We collect the minimum information necessary to operate the service:</P>
        <UL items={[
          'Dashboard layout and widget configurations (stored locally in your browser\'s localStorage)',
          'User preferences such as selected tickers, yield selections, and visibility settings (localStorage only)',
          'Standard server access logs including IP address and request timestamps — retained for 30 days for security purposes',
        ]} />
        <P>We do not collect names, email addresses, financial account information, or any payment data.</P>
      </Section>

      <Section title="3. Cookies and Local Storage">
        <P>This application uses browser localStorage (not cookies) to persist your dashboard configuration. This data never leaves your device and is not transmitted to our servers. You may clear this data at any time through your browser settings.</P>
      </Section>

      <Section title="4. Third-Party Data Providers">
        <P>Market data is sourced from the following third-party providers, each subject to their own privacy policies:</P>
        <UL items={[
          'Yahoo Finance (via yfinance) — price history, options chains, news',
          'Financial Modeling Prep (FMP) — fundamental data, analyst ratings',
          'TradingView — embedded chart widgets loaded via TradingView\'s CDN',
          'Federal Reserve Economic Data (FRED) — interest rate data via St. Louis Fed API',
        ]} />
        <P>When the TradingView chart widget loads, TradingView may set its own cookies in accordance with TradingView's privacy policy.</P>
      </Section>

      <Section title="5. Data Security">
        <P>All data in transit is encrypted via HTTPS/TLS. Dashboard configurations stored in localStorage are confined to your browser and device. We do not maintain databases of user activity or preferences on our servers.</P>
      </Section>

      <Section title="6. Your Rights">
        <P>You may clear all locally stored preferences at any time by clearing your browser's localStorage for this domain. For any privacy concerns, contact us at the address provided in the Terms of Use.</P>
      </Section>

      <Section title="7. Changes to This Policy">
        <P>We may update this policy as the platform evolves. Material changes will be reflected in the "Last updated" date above. Continued use of the platform after changes constitutes acceptance of the revised policy.</P>
      </Section>
    </LegalPage>
  )
}
