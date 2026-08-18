"""Parsing two brokerage exports into one ledger.

The fixtures are synthetic and deliberately so: a real export carries account
numbers, and the shapes below reproduce every quirk that mattered without
putting anyone's statement in the repository.

Both quirk sets are taken from real files: Fidelity's byte-order mark, blank
lead-in and trailing disclaimer, its free-text Action verbs and its
" -NVDA260807C200" option symbols; Robinhood's newline inside a quoted
Description, its "$714.48" and "($1.28)" money, and its four-letter codes.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest  # noqa: E402

import brokerage_import as B  # noqa: E402

FIDELITY = '''

Run Date,Account,Account Number,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date
08/10/2026,Individual,X1,YOU SOLD SOME ETF (TSLL) (Cash),TSLL,SOME ETF,Cash,8.15,"-20","","","",162.9,08/11/2026
08/05/2026,ROTH IRA,X2,REINVESTMENT VANGUARD (BND) (Cash),BND,VANGUARD BOND,Cash,72.39,0.01,"","","","-0.75",""
08/05/2026,ROTH IRA,X2,DIVIDEND RECEIVED VANGUARD (BND) (Cash),BND,VANGUARD BOND,Cash,"",0,"","","",0.75,""
08/03/2026,Individual,X1,YOU SOLD CLOSING TRANSACTION CALL (NVDA) AUG 07 26 $200 (Cash)," -NVDA260807C200",CALL (NVDA) AUG 07 26 $200,Cash,8.93,"-1",0.65,0.03,"",892.32,08/04/2026
07/21/2026,Individual,X1,TRANSFER OF ASSETS ACAT RECEIVE (Cash),VOO,VANGUARD S&P 500,Cash,687.87,3,"","","",2063.61,
07/16/2026,Individual,X1,Electronic Funds Transfer Received (Cash),,No Description,Cash,"",0,"","","",100.00,
07/20/2026,Individual,X1,YOU BOUGHT SOME ETF (SPY) (Cash),SPY,SPDR S&P 500,Cash,600.00,1,"","","",-600.00,07/21/2026

"Brokerage services provided by Fidelity Brokerage Services LLC. This is not a"
"recommendation for any security. Data shown is based on information known as of"
'''

ROBINHOOD = '''"Activity Date","Process Date","Settle Date","Instrument","Description","Trans Code","Quantity","Price","Amount"
"7/13/2026","7/13/2026","7/14/2026","QQQ","Invesco QQQ
CUSIP: 46090E103
Dividend Reinvestment","Buy","0.001791","$714.48","($1.28)"
"7/10/2026","7/10/2026","7/10/2026","QQQ","Cash Div: R/D 2026-06-22","CDIV","","","$1.28"
"7/7/2026","7/7/2026","7/8/2026","QQQ","Invesco QQQ","Buy","0.700889","$713.38","($500.00)"
"6/2/2026","6/2/2026","6/2/2026","","Current Year Contribution","CFIR","","","$1,500.00"
"5/2/2026","5/2/2026","5/2/2026","ARKK","Stock Lending","SLIP","","","$0.01"
"4/2/2026","4/2/2026","4/3/2026","ARKK","ARK Innovation ETF","Sell","4","$75.71","$302.84"
"3/2/2026","3/2/2026","3/2/2026","","Interest on Contribution (IRA Match)","MTCH","","","$45.00"
'''


class TestMoney:
    @pytest.mark.parametrize("raw,want", [
        ("$1,027.99", 1027.99), ("($1.28)", -1.28), ("$0.01", 0.01),
        ("", 0.0), ("-20", -20.0), ("162.9", 162.9),
    ])
    def test_broker_money_formats(self, raw, want):
        assert B._money(raw) == pytest.approx(want)


class TestFidelity:
    def setup_method(self):
        self.r = B.parse(FIDELITY)

    def test_it_reads_past_the_bom_and_the_blank_lines(self):
        assert self.r.source == "fidelity"
        assert len(self.r.txns) == 7

    def test_the_trailing_disclaimer_is_not_a_transaction(self):
        # Those rows have prose where the date belongs.
        assert all(t.date is not None for t in self.r.txns)
        assert not any("Brokerage services" in t.description for t in self.r.txns)

    def test_the_action_verb_becomes_the_kind(self):
        by_symbol = {(t.symbol, t.kind) for t in self.r.txns}
        assert ("TSLL", "sell") in by_symbol
        assert ("SPY", "buy") in by_symbol
        assert ("BND", "buy") in by_symbol          # REINVESTMENT is a purchase
        assert ("BND", "dividend") in by_symbol

    def test_an_option_symbol_is_recognised(self):
        opt = [t for t in self.r.txns if t.is_option]
        assert len(opt) == 1 and opt[0].symbol == "NVDA260807C200"

    def test_several_accounts_are_reported(self):
        assert self.r.accounts == ["Individual", "ROTH IRA"]

    def test_a_transfer_of_assets_is_external(self):
        acat = next(t for t in self.r.txns if t.symbol == "VOO")
        assert acat.kind == "deposit"
        assert acat.quantity == 3 and acat.amount == pytest.approx(2063.61)

    def test_commissions_and_fees_are_summed(self):
        opt = next(t for t in self.r.txns if t.is_option)
        assert opt.fees == pytest.approx(0.68)


class TestRobinhood:
    def setup_method(self):
        self.r = B.parse(ROBINHOOD)

    def test_a_newline_inside_a_quoted_field_does_not_split_the_row(self):
        assert self.r.source == "robinhood"
        assert len(self.r.txns) == 7

    def test_the_four_letter_codes_are_classified(self):
        kinds = {t.kind for t in self.r.txns}
        assert {"buy", "sell", "dividend", "interest", "deposit"} <= kinds

    def test_a_contribution_is_a_deposit_not_income(self):
        # The single easiest way to report a fabulous return is to count the
        # money someone paid in as money they made.
        contribution = next(t for t in self.r.txns if t.amount == 1500.0)
        assert contribution.kind == "deposit"
        assert contribution.kind in B.EXTERNAL_KINDS

    def test_an_ira_match_is_external_too(self):
        match = next(t for t in self.r.txns if t.amount == 45.0)
        assert match.kind == "deposit"

    def test_stock_lending_is_internal_income(self):
        lending = next(t for t in self.r.txns if t.symbol == "ARKK" and t.amount == 0.01)
        assert lending.kind == "interest"
        assert lending.kind not in B.EXTERNAL_KINDS

    def test_bracketed_amounts_are_negative(self):
        buy = next(t for t in self.r.txns if t.amount == -500.0)
        assert buy.kind == "buy" and buy.price == pytest.approx(713.38)


class TestDetection:
    def test_each_export_identifies_itself(self):
        assert B.detect_source(FIDELITY) == "fidelity"
        assert B.detect_source(ROBINHOOD) == "robinhood"

    def test_something_else_is_refused_with_instructions(self):
        with pytest.raises(ValueError, match="Export transaction history"):
            B.parse("date,amount\n2026-01-01,5\n")

    def test_the_ledger_comes_back_in_date_order(self):
        dates = [t.date for t in B.parse(FIDELITY).txns]
        assert dates == sorted(dates)
