import { describe, it, expect } from 'vitest'
import { parseTickers, parseTickerFile } from './TickerBasket'

// These parsers decide which symbols get scanned. A silent drop is the failure
// that matters: the scan runs, looks successful, and quietly omits a name.

describe('parseTickers', () => {
  it('splits on every separator a pasted list actually uses', () => {
    expect(parseTickers('AAPL, MSFT NVDA;TSLA|AMD\nGOOGL\tMETA'))
      .toEqual(['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'GOOGL', 'META'])
  })

  it('uppercases and trims', () => {
    expect(parseTickers('  aapl , msft ')).toEqual(['AAPL', 'MSFT'])
  })

  it('strips the $ prefix people paste from social posts', () => {
    expect(parseTickers('$AAPL $NVDA')).toEqual(['AAPL', 'NVDA'])
  })

  it('strips surrounding quotes and trailing punctuation', () => {
    expect(parseTickers('"AAPL", \'MSFT\', NVDA.')).toEqual(['AAPL', 'MSFT', 'NVDA'])
  })

  it('keeps share-class symbols', () => {
    expect(parseTickers('BRK-B BF.B')).toEqual(['BRK-B', 'BF.B'])
  })

  it('drops things that cannot be symbols instead of scanning them', () => {
    expect(parseTickers('AAPL 12345 !!! toolongsymbol')).toEqual(['AAPL'])
  })

  it('is empty for empty input', () => {
    expect(parseTickers('')).toEqual([])
    expect(parseTickers('   ')).toEqual([])
  })
})

describe('parseTickerFile', () => {
  it('takes the first column of a CSV', () => {
    const csv = 'AAPL,100,150.25\nMSFT,50,410.00\nNVDA,25,880.10'
    expect(parseTickerFile(csv)).toEqual(['AAPL', 'MSFT', 'NVDA'])
  })

  it('skips a header row', () => {
    expect(parseTickerFile('Ticker,Shares\nAAPL,100\nMSFT,50')).toEqual(['AAPL', 'MSFT'])
    expect(parseTickerFile('Symbol,Qty\nNVDA,10')).toEqual(['NVDA'])
  })

  it('does not mistake a real ticker on line one for a header', () => {
    expect(parseTickerFile('AAPL,100\nMSFT,50')).toEqual(['AAPL', 'MSFT'])
  })

  it('reads a plain one-per-line list', () => {
    expect(parseTickerFile('AAPL\nMSFT\nNVDA\n')).toEqual(['AAPL', 'MSFT', 'NVDA'])
  })

  it('reads a whole list on one line', () => {
    expect(parseTickerFile('AAPL, MSFT, NVDA')).toEqual(['AAPL', 'MSFT', 'NVDA'])
  })

  it('handles tab-separated exports', () => {
    expect(parseTickerFile('Symbol\tShares\nAAPL\t100\nMSFT\t50')).toEqual(['AAPL', 'MSFT'])
  })

  it('handles CRLF line endings', () => {
    expect(parseTickerFile('AAPL,1\r\nMSFT,2\r\n')).toEqual(['AAPL', 'MSFT'])
  })

  it('skips comment and blank lines', () => {
    expect(parseTickerFile('# my book\n\nAAPL,1\n\nMSFT,2\n')).toEqual(['AAPL', 'MSFT'])
  })

  it('returns nothing for a file with no symbols, rather than junk', () => {
    expect(parseTickerFile('date,amount\n2026-01-01,500\n2026-02-01,600')).toEqual([])
  })
})
