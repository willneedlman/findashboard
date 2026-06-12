import LegalPage, { Section, P, UL } from './LegalPage'

export default function TermsOfUse() {
  return (
    <LegalPage title="Terms of Use" lastUpdated="June 2026">
      <Section title="1. Acceptance of Terms">
        <P>By accessing or using Alphatape Terminal ("the Platform"), you agree to be bound by these Terms of Use. If you do not agree, do not use the Platform.</P>
      </Section>

      <Section title="2. No Investment Advice">
        <P>The Platform and all content, data, tools, models, analytics, and outputs provided are for <strong>informational and educational purposes only</strong>. Nothing on the Platform constitutes:</P>
        <UL items={[
          'Investment advice or a recommendation to buy, sell, or hold any security',
          'Financial, tax, legal, or accounting advice',
          'An offer or solicitation to buy or sell any security or financial instrument',
          'A guarantee of future performance or investment returns',
        ]} />
        <P>Always consult a qualified, licensed financial professional before making investment decisions.</P>
      </Section>

      <Section title="3. Permitted Use">
        <P>You may use the Platform solely for personal, non-commercial research and analysis. You may not:</P>
        <UL items={[
          'Redistribute, resell, or sublicense access to the Platform or its data',
          'Use automated scraping or crawling tools against the Platform\'s API',
          'Use the Platform in any manner that violates applicable laws or regulations',
          'Attempt to gain unauthorized access to any systems or data',
        ]} />
      </Section>

      <Section title="4. Data Accuracy and Availability">
        <P>Market data is sourced from third-party providers and is provided "as is" without warranties of accuracy, completeness, or timeliness. Financial data may be delayed, inaccurate, or unavailable at times. The Platform makes no representation that any data is current or accurate.</P>
        <P>The Platform may be unavailable due to maintenance, technical failures, or third-party API outages. We do not guarantee uptime or continuity of service.</P>
      </Section>

      <Section title="5. Limitation of Liability">
        <P>To the maximum extent permitted by applicable law, the Platform and its operators shall not be liable for any direct, indirect, incidental, special, consequential, or punitive damages arising from your use of or inability to use the Platform, including but not limited to losses arising from reliance on any data, model output, or analytical tool provided herein.</P>
      </Section>

      <Section title="6. Intellectual Property">
        <P>The Platform's code, design, and original content are the property of its operators. Third-party data remains the property of respective data providers. TradingView charts are subject to TradingView's terms of service.</P>
      </Section>

      <Section title="7. Governing Law">
        <P>These Terms shall be governed by and construed in accordance with the laws of the jurisdiction in which the operator resides, without regard to conflict of law principles.</P>
      </Section>

      <Section title="8. Modifications">
        <P>We reserve the right to modify these Terms at any time. Continued use of the Platform after modifications constitutes acceptance of the updated Terms.</P>
      </Section>
    </LegalPage>
  )
}
