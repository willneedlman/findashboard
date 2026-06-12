import LegalPage, { Section, P, UL } from './LegalPage'

export default function RiskDisclosure() {
  return (
    <LegalPage title="Risk Disclosure" lastUpdated="June 2026">
      <Section title="General Investment Risk">
        <P>All investing involves risk, including the possible loss of principal. The value of investments can go down as well as up. Past performance does not guarantee future results.</P>
      </Section>

      <Section title="Options and Derivatives Risk">
        <P>Options, futures, and other derivative instruments involve substantial risks and are not appropriate for all investors. Specific risks include:</P>
        <UL items={[
          'Options can expire worthless, resulting in total loss of premium paid',
          'Selling (writing) options exposes the seller to potentially unlimited loss',
          'Complex strategies (spreads, condors, straddles) involve multiple simultaneous risks',
          'Implied volatility changes can significantly affect option pricing independent of underlying price movement',
          'Early assignment risk on short options positions',
          'Liquidity risk — some options may be difficult to exit at a fair price',
          'Pin risk near expiration when the underlying trades near a strike price',
        ]} />
      </Section>

      <Section title="Model and Analytical Tool Risk">
        <P>The quantitative models and analytical tools on this Platform (Black-Scholes pricing, Monte Carlo simulations, DCF valuations, Greeks calculators, etc.) are mathematical approximations with inherent limitations:</P>
        <UL items={[
          'Black-Scholes assumes constant volatility and log-normal returns, which do not hold in practice',
          'Monte Carlo simulations are probabilistic and each run produces different results; outputs are not predictions',
          'DCF valuations are highly sensitive to input assumptions; small changes in growth rates or discount rates produce large changes in output',
          'Historical volatility is a backward-looking measure and may not predict future volatility',
          'Correlation matrices assume stable relationships that can break down during market stress',
          'Implied probability distributions are derived from market prices and reflect market consensus, not certainty',
        ]} />
        <P>Model outputs should be used as one input among many in a broader analytical framework, not as standalone trading signals.</P>
      </Section>

      <Section title="Data Risk">
        <P>Market data displayed on this Platform may be delayed, inaccurate, incomplete, or unavailable. Do not rely on this data for time-sensitive trading decisions. Always verify data against your broker or a licensed data provider before executing trades.</P>
      </Section>

      <Section title="Volatility and Liquidity Risk">
        <P>Markets can experience periods of extreme volatility where normal pricing relationships break down. During these periods, theoretical model values may diverge significantly from executable market prices. Bid-ask spreads can widen dramatically, and strategies that appear profitable in theory may be impossible to implement at the modeled prices.</P>
      </Section>

      <Section title="No Regulatory Registration">
        <P>Alphatape Terminal is not registered with the SEC, FINRA, NFA, CFTC, or any other financial regulatory body. We are not a broker-dealer, investment adviser, commodity trading adviser, or any other registered financial intermediary. We do not provide personalized investment recommendations.</P>
      </Section>
    </LegalPage>
  )
}
