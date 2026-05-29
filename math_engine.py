import numpy as np
from scipy.stats import norm

def bs_price(S, K, T, r, sigma, option_type):
    T, r, sigma = T/365, r/100, sigma/100
    d1 = (np.log(S/K) + (r + 0.5*sigma**2)*T) / (sigma*np.sqrt(T))
    d2 = d1 - sigma*np.sqrt(T)
    if option_type == "call":
        return S*norm.cdf(d1) - K*np.exp(-r*T)*norm.cdf(d2)
    return K*np.exp(-r*T)*norm.cdf(-d2) - S*norm.cdf(-d1)

def bs_greeks(S, K, T, r, sigma, option_type):
    T, r, sigma = T/365, r/100, sigma/100
    d1    = (np.log(S/K) + (r + 0.5*sigma**2)*T) / (sigma*np.sqrt(T))
    d2    = d1 - sigma*np.sqrt(T)
    delta = norm.cdf(d1) if option_type == "call" else norm.cdf(d1) - 1
    gamma = norm.pdf(d1) / (S*sigma*np.sqrt(T))
    theta_call = (-(S*norm.pdf(d1)*sigma)/(2*np.sqrt(T)) - r*K*np.exp(-r*T)*norm.cdf(d2))
    theta = theta_call/365 if option_type == "call" else (theta_call + r*K*np.exp(-r*T))/365
    vega  = S*norm.pdf(d1)*np.sqrt(T)/100
    return {"delta": delta, "gamma": gamma, "theta": theta, "vega": vega}

def bond_price(face, coupon_rate, maturity, ytm, frequency=2):
    periods    = int(maturity * frequency)
    coupon     = (coupon_rate/100 / frequency) * face
    rate       = ytm/100 / frequency
    pv_coupons = coupon * (1 - (1+rate)**(-periods)) / rate
    pv_face    = face / (1+rate)**periods
    return pv_coupons + pv_face

def duration_convexity(face, coupon_rate, maturity, ytm, frequency=2):
    periods   = int(maturity * frequency)
    coupon    = (coupon_rate/100 / frequency) * face
    rate      = ytm/100 / frequency
    price     = bond_price(face, coupon_rate, maturity, ytm, frequency)
    times     = [t/frequency for t in range(1, periods+1)]
    cfs       = [coupon]*periods
    cfs[-1]  += face
    pv_flows  = [cf/(1+rate)**t for cf,t in zip(cfs, range(1, periods+1))]
    mac_dur   = sum(t*pv/price for t,pv in zip(times, pv_flows))
    mod_dur   = mac_dur / (1+rate)
    convexity = sum(pv*t*(t+1/frequency) for t,pv in zip(times, pv_flows)) / (price*(1+rate)**2)
    return {"price": price, "mac_duration": mac_dur, "mod_duration": mod_dur, "convexity": convexity}