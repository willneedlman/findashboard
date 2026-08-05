import { motion } from 'framer-motion'
import PageHeader from './PageHeader'

// Emil's strong ease-out curve — feels more intentional than framer's default easeOut.
const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1]

const variants = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.28, ease: EASE_OUT } },
  exit:    { opacity: 0, y: -6, transition: { duration: 0.15, ease: EASE_OUT } },
}

interface PageWrapperProps {
  children: React.ReactNode
  title?: string
}

export default function PageWrapper({ children, title }: PageWrapperProps) {
  return (
    <motion.div className="ft-print-page" variants={variants} initial="initial" animate="animate" exit="exit">
      {title && <PageHeader title={title} />}
      {children}
    </motion.div>
  )
}
