import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import peer_multiples as P


def test_catalogue_is_consistent():
    cat = P.catalogue()
    assert len(cat) == len(P.PEER_PS)
    assert {c["name"] for c in cat} == set(P.PEER_PS)
    for c in cat:
        assert c["ps"] > 0 and c["family"] and c["note"]


def test_microsoft_segments_split_by_business_not_by_the_word_services():
    """Every Microsoft line used to collapse onto 'Software / Cloud' or, if the
    label contained 'services', onto 'Internet / Media'."""
    got = {n: P.classify(n) for n in [
        "Server Products and Cloud Services",
        "Microsoft 365 Commercial Products and Cloud Services",
        "Xbox", "LinkedIn Corporation", "Windows and Devices",
        "Search Advertising", "Dynamics Products and Cloud Services",
        "Enterprise and Partner Services",
    ]}
    assert got["Server Products and Cloud Services"] == "Hyperscale Cloud / IaaS"
    assert got["Microsoft 365 Commercial Products and Cloud Services"] == "Enterprise SaaS / Productivity"
    assert got["Dynamics Products and Cloud Services"] == "ERP / Business Applications"
    assert got["LinkedIn Corporation"] == "Professional Network / Hiring"
    assert got["Search Advertising"] == "Search Advertising"
    assert got["Xbox"] == "Interactive / Live-Service"
    assert got["Windows and Devices"] == "Client OS / PC Software"
    # An integration/support business must not inherit a software multiple.
    assert got["Enterprise and Partner Services"] == "IT Services / Consulting"
    assert P.PEER_PS[got["Enterprise and Partner Services"]] < P.PEER_PS[got["Server Products and Cloud Services"]]


def test_industry_context_disambiguates_shared_labels():
    """'Gaming' is a release slate at a publisher and GeForce silicon at Nvidia."""
    assert P.classify("Gaming") == "Video Game Publishing"
    assert P.classify("Gaming", "semis") == "Fabless Semiconductors"
    assert P.classify("Compute", "semis") == "AI Accelerators / DC Silicon"
    assert P.classify("Automotive") == "Automotive OEM"
    assert P.classify("Automotive", "semis") == "Fabless Semiconductors"


def test_context_for_maps_industry_strings():
    assert P.context_for("Semiconductors", "Technology") == "semis"
    assert P.context_for("Banks - Diversified", "Financial Services") == "banks"
    assert P.context_for("Software - Infrastructure", "Technology") is None
    assert P.context_for(None, None) is None


def test_residual_segments_stay_unclassified():
    """No comp is better than a wrong comp: these fall back to the blended P/S."""
    for name in ["Other Products and Services", "All Other Segments", "Corporate", "Eliminations"]:
        assert P.classify(name) is None


def test_premium_devices_outrank_commodity_pcs():
    assert P.classify("iPhone") == "Consumer Electronics (premium)"
    assert P.classify("Mac") == "PCs / Consumer Devices"
    assert P.PEER_PS["Consumer Electronics (premium)"] > P.PEER_PS["PCs / Consumer Devices"]
