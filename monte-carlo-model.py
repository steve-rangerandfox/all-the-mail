import numpy as np
rng = np.random.default_rng(42)
N = 1000          # Monte Carlo runs (as requested)
MONTHS = 18
PRICE = 15.0
GROSS_MARGIN = 0.80   # after Google API/infra/Stripe fees

def tri(a,b,c,size): return rng.triangular(a,b,c,size)

# ---------- sampled inputs (per-run) ----------
launch_month   = rng.integers(2,5,N)                 # ProductHunt/HN launch month (2-4)
ph_trials      = tri(30, 140, 550, N)                # one-time trial starts from launch spike
seo_base6      = tri(3, 12, 45, N)                   # SEO-driven trial starts/mo by month 6
seo_growth     = tri(0.03, 0.10, 0.22, N)            # monthly compounding of SEO
comm_trials    = tri(2, 12, 45, N)                   # communities/creators trials/mo (noisy)
ad_budget      = tri(0, 700, 3000, N)                # monthly paid-ads budget $
cost_per_trial = tri(9, 22, 55, N)                   # $ per trial-start via ads (card-upfront filter is costly)
referral_rate  = tri(0.0, 0.015, 0.05, N)           # monthly new trials per active payer (viral loop)

activation     = tri(0.35, 0.58, 0.78, N)            # % of trials that connect a 2nd account (the magic moment)
conv_act       = tri(0.45, 0.62, 0.80, N)            # activated trial -> paid (card already on file)
conv_noact     = tri(0.08, 0.20, 0.38, N)            # non-activated trial -> paid
churn          = tri(0.025, 0.055, 0.10, N)          # monthly logo churn on payers

# effective trial->paid
t2p = activation*conv_act + (1-activation)*conv_noact

payers = np.zeros((N, MONTHS+1))
trials_total = np.zeros(N)
paid_spend = np.zeros(N)
paid_trials_total = np.zeros(N)

for t in range(1, MONTHS+1):
    seo_t = seo_base6 * (1+seo_growth)**(t-6)                 # ramps; small early, compounds
    seo_t = np.where(t < 2, seo_t*0.2, seo_t)                 # near-zero pre-launch
    ad_trials = np.minimum(ad_budget/cost_per_trial, 400)     # budget-bounded
    ref_trials = payers[:,t-1]*referral_rate
    ph_t = np.where(t==launch_month, ph_trials, 0.0)
    trials_t = seo_t + comm_trials*rng.uniform(0.5,1.5,N) + ad_trials + ref_trials + ph_t
    trials_t = np.maximum(trials_t, 0)
    new_payers = trials_t * t2p
    payers[:,t] = payers[:,t-1]*(1-churn) + new_payers
    trials_total += trials_t
    paid_spend += ad_budget
    paid_trials_total += ad_trials

p12 = payers[:,12]; p18 = payers[:,18]
hit1000_12 = p12>=1000
hit1000_18 = p18>=1000
# months to 1000
months_to_1k = np.full(N, np.nan)
for i in range(N):
    idx = np.where(payers[i]>=1000)[0]
    if len(idx): months_to_1k[i]=idx[0]

mrr18 = p18*PRICE
ltv = (PRICE*GROSS_MARGIN)/np.clip(churn,1e-3,None)          # $ LTV per payer
paid_payers = paid_trials_total*t2p
blended_cac = np.where(paid_payers>0, paid_spend/np.clip(paid_payers,1e-6,None), np.nan)
ltv_cac = ltv/np.where(np.isnan(blended_cac)|(blended_cac<1),1e9,blended_cac)
ltv_cac = np.where(paid_spend<50, np.nan, ltv_cac)          # only meaningful if actually spending

def pct(x,p): return np.nanpercentile(x,p)
def line(name,x):
    print(f"{name:<26} P10={pct(x,10):>9.0f}  P50={pct(x,50):>9.0f}  P90={pct(x,90):>9.0f}  mean={np.nanmean(x):>9.0f}")

print("="*78)
print(f"ALL THE MAIL — Monte Carlo ({N} runs, {MONTHS}mo, $15/mo card-upfront trial)")
print("="*78)
line("Paying users @ month 12", p12)
line("Paying users @ month 18", p18)
line("MRR @ month 18 ($)", mrr18)
print("-"*78)
print(f"P(>=1,000 payers by M12): {hit1000_12.mean()*100:5.1f}%")
print(f"P(>=1,000 payers by M18): {hit1000_18.mean()*100:5.1f}%")
print(f"P(>=  500 payers by M18): {(p18>=500).mean()*100:5.1f}%")
print(f"P(>=2,000 payers by M18): {(p18>=2000).mean()*100:5.1f}%")
print(f"P(>=5,000 payers by M18): {(p18>=5000).mean()*100:5.1f}%")
mk = months_to_1k[~np.isnan(months_to_1k)]
print(f"Of runs that hit 1,000: median month reached = {np.median(mk):.0f}" if len(mk) else "none hit 1000")
print("-"*78)
print(f"Blended LTV per payer ($):   P50={pct(ltv,50):.0f}  (churn-driven)")
print(f"Blended CAC via ads ($):     P50={pct(blended_cac,50):.0f}")
print(f"LTV:CAC (paid runs only):    P50={pct(ltv_cac,50):.1f}  P10={pct(ltv_cac,10):.1f}")
print(f"P(LTV:CAC >= 3): {np.nanmean(ltv_cac>=3)*100:.1f}%  (of runs with real ad spend)")
print("-"*78)
# composite success: >=1000 payers by M18 AND healthy retention (churn<7%) AND unit econ ok if spending
success = hit1000_18 & (churn<0.07)
print(f"P(composite success: 1k payers @M18 + churn<7%): {success.mean()*100:.1f}%")

# ---------- driver analysis: correlation of each input with payers@18 ----------
def spearman(a,b):
    ra=np.argsort(np.argsort(a)); rb=np.argsort(np.argsort(b))
    return np.corrcoef(ra,rb)[0,1]
inputs = {
 "SEO base volume (mo6)":seo_base6, "SEO monthly growth":seo_growth,
 "ProductHunt launch size":ph_trials, "Community/creator trials":comm_trials,
 "Ad budget/mo":ad_budget, "Cost per trial (ads)":cost_per_trial,
 "Referral rate (k)":referral_rate, "Activation (2nd acct)":activation,
 "Activated trial->paid":conv_act, "Non-activated trial->paid":conv_noact,
 "Monthly churn":churn, "Effective trial->paid":t2p,
}
print("="*78)
print("DRIVERS — Spearman corr with paying-users@M18 (what moves the outcome most)")
print("="*78)
for name,x in sorted(inputs.items(), key=lambda kv:-abs(spearman(kv[1],p18))):
    r=spearman(x,p18); bar="#"*int(abs(r)*40)
    print(f"{name:<28} r={r:+.2f} {bar}")
