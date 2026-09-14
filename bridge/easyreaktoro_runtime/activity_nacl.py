"""Individual ion sizes, mole-fraction conversion, dynamic NaCl b-gamma.

Temperature-pressure equations follow Oelkers & Helgeson (1990), Appendix B,
with individual ion sizes and the paired osmotic water relation. This is an
explicit activity-model choice, separate from RTDB standard-state equations.
No species records or personal database are embedded here.
"""
from __future__ import annotations
import math
import numpy as np
import reaktoro as rkt

TREF_K = 298.15

PREF_BAR = 1.0

EPSILON_REF = 78.24513795

Y_REF = -5.798650444e-5

ETA = 1.66027e5

R_CAL = 1.98721

LN10 = math.log(10.0)

THETA_K = 228.0

PSI_BAR = 2600.0

WATER_MOLAR_MASS_KG_PER_MOL = 0.0180153

NACL_B_GAMMA_EOS = {
    "nu": 2.0,
    "a1": 0.030056,
    "a2": -202.55,
    "a3": -2.9092,
    "a4": 20302.0,
    "a5": -0.2060,
    "c1": -1.50,
    "c2": 53300.0,
    "omega_ref": 178650.0,
    "b_gibbs_work": -174.623,
    "b_entropy_work": 2.164,
    "r_cation": 0.97,
    "r_anion": 1.81,
}

def water_properties(temperature_k, pressure_bar):
    pressure_pa = float(pressure_bar) * 1.0e5
    thermo = rkt.waterThermoPropsHGK(
        float(temperature_k), pressure_pa, rkt.StateOfMatter.Liquid
    )
    electro = rkt.waterElectroPropsJohnsonNorton(
        float(temperature_k), pressure_pa, thermo
    )
    rho = float(thermo.D) / 1000.0
    epsilon = float(electro.epsilon)
    if not np.isfinite(rho) or not np.isfinite(epsilon) or rho <= 0.0 or epsilon <= 0.0:
        raise ValueError(
            f"水性质无效：T={temperature_k - 273.15:g} °C, "
            f"P={pressure_bar:g} bar, rho={rho}, epsilon={epsilon}"
        )
    return rho, epsilon

def shock_g_function(temperature_k, pressure_bar, rho_g_cm3):
    temperature_c = float(temperature_k) - 273.15
    c = (
        -2.037662, 0.005747, -6.557892e-6,
        6.107361, -0.01074377, 1.268348e-5,
    )
    cc = (36.66666, -1.504956e-10, 5.017997e-14)
    aa = c[0] + c[1] * temperature_c + c[2] * temperature_c**2
    bb = c[3] + c[4] * temperature_c + c[5] * temperature_c**2
    g_value = aa * abs(1.0 - rho_g_cm3)**bb
    if 155.0 <= temperature_c <= 355.0 and pressure_bar <= 1000.0:
        y = (temperature_c - 155.0) / 300.0
        g_value -= (y**4.8 + cc[0] * y**16) * (
            cc[1] * (1000.0 - pressure_bar)**3
            + cc[2] * (1000.0 - pressure_bar)**4
        )
    return g_value

def evaluate_nacl_parameters(temperature_c, pressure_bar):
    temperature_k = float(temperature_c) + 273.15
    pressure_bar = float(pressure_bar)
    rho, epsilon = water_properties(temperature_k, pressure_bar)
    g_value = shock_g_function(temperature_k, pressure_bar, rho)

    def omega(current_g):
        return ETA * (
            1.0 / (NACL_B_GAMMA_EOS["r_cation"] + 0.94 + current_g)
            + 1.0 / (NACL_B_GAMMA_EOS["r_anion"] + current_g)
        )

    t = temperature_k
    p = pressure_bar
    nbg = (
        -NACL_B_GAMMA_EOS["nu"] * NACL_B_GAMMA_EOS["b_gibbs_work"] / 2.0
        + NACL_B_GAMMA_EOS["nu"] * NACL_B_GAMMA_EOS["b_entropy_work"]
        * (t - TREF_K) / 2.0
        - NACL_B_GAMMA_EOS["c1"] * (t * math.log(t / TREF_K) - t + TREF_K)
        + NACL_B_GAMMA_EOS["a1"] * (p - PREF_BAR)
        + NACL_B_GAMMA_EOS["a2"] * math.log((PSI_BAR + p) / (PSI_BAR + PREF_BAR))
        - NACL_B_GAMMA_EOS["c2"] * (
            (1.0 / (t - THETA_K) - 1.0 / (TREF_K - THETA_K))
            * (THETA_K - t) / THETA_K
            - t / THETA_K**2
            * math.log((TREF_K * (t - THETA_K)) / (t * (TREF_K - THETA_K)))
        )
        + (
            NACL_B_GAMMA_EOS["a3"] * (p - PREF_BAR)
            + NACL_B_GAMMA_EOS["a4"]
            * math.log((PSI_BAR + p) / (PSI_BAR + PREF_BAR))
        ) / (t - THETA_K)
        + NACL_B_GAMMA_EOS["a5"] * (
            omega(g_value) * (1.0 / epsilon - 1.0)
            - NACL_B_GAMMA_EOS["omega_ref"] * (1.0 / EPSILON_REF - 1.0)
            + Y_REF * NACL_B_GAMMA_EOS["omega_ref"] * (t - TREF_K)
        )
    )
    values = {
        "temperature_c": float(temperature_c),
        "pressure_bar": pressure_bar,
        "rho_g_cm3": rho,
        "epsilon": epsilon,
        "g": g_value,
        "A_gamma": 1.824829238e6 * math.sqrt(rho) / (t * epsilon)**1.5,
        "B_gamma": 50.29158649 * math.sqrt(rho) / math.sqrt(t * epsilon),
        "b_gamma": nbg / (NACL_B_GAMMA_EOS["nu"] * LN10 * R_CAL * t),
    }
    if not all(np.isfinite(value) for value in values.values()):
        raise ValueError(f"当前温压点得到非有限活度模型参数：{values}")
    return values

def stable_sigma(y):
    value = abs(float(y))
    if value < 1.0e-4:
        return (
            1.0 - 1.5 * y + 1.8 * y**2
            - 2.0 * y**3 + (15.0 / 7.0) * y**4
        )
    lam = 1.0 + y
    return 3.0 / y**3 * (lam - 1.0 / lam - 2.0 * lam.log())

def stable_alpha(solute_ratio):
    value = abs(float(solute_ratio))
    if value < 1.0e-6:
        return -(
            1.0 - solute_ratio / 2.0 + solute_ratio**2 / 3.0
            - solute_ratio**3 / 4.0 + solute_ratio**4 / 5.0
        ) / LN10
    return -(1.0 + solute_ratio).log() / (solute_ratio * LN10)


class NaClActivity:
    """One run owns its arrays/cache; never changes global Reaktoro defaults."""

    def __init__(self, names, charges, sizes, water):
        self.names = list(names)
        self.charges = list(charges)
        self.sizes = list(sizes)
        self.water_index = self.names.index(water)
        self.cache = {}
        self.active_key = None

    def activate(self, temperature_c, pressure_bar):
        key = (round(float(temperature_c), 8), round(float(pressure_bar), 8))
        if key not in self.cache:
            self.cache[key] = evaluate_nacl_parameters(*key)
        self.active_key = key
        return self.cache[key]

    def generator(self, phase_species):
        actual = [str(x.name()) for x in phase_species]
        if actual != self.names:
            raise ValueError("活度模型物种顺序与水相不一致")
        return rkt.ActivityModel(self.evaluate)

    def evaluate(self, args):
        key = (round(float(args.T) - 273.15, 8), round(float(args.P) / 1e5, 8))
        if key != self.active_key:
            raise ValueError("当前温压尚未激活对应的 NaCl 活度参数")
        dynamic = self.cache[key]
        a, b, linear = (dynamic[k] for k in ("A_gamma", "B_gamma", "b_gamma"))
        x, wi = args.x, self.water_index
        xw = x[wi]
        if float(xw) <= 0:
            raise ValueError("水相水摩尔分数必须为正")
        molalities = [xw * 0.0 if i == wi else x[i] / (xw * WATER_MOLAR_MASS_KG_PER_MOL)
                      for i in range(len(self.names))]
        total, ionic = xw * 0.0, xw * 0.0
        for i, z in enumerate(self.charges):
            if i != wi:
                total += molalities[i]
                if z:
                    ionic += 0.5 * molalities[i] * z * z
        sqrt_i, ln_xw = ionic.sqrt(), xw.log()
        alpha = stable_alpha(WATER_MOLAR_MASS_KG_PER_MOL * total)
        osmotic = xw * 0.0
        props = rkt.ActivityProps.create(len(self.names))
        for i, z in enumerate(self.charges):
            if i == wi:
                continue
            molality = molalities[i]
            if not z:
                ln_gamma = ln_xw
                osmotic += molality * alpha
            else:
                y = b * self.sizes[i] * sqrt_i
                ln_gamma = ln_xw + LN10 * (-a * z * z * sqrt_i / (1.0 + y) + linear * ionic)
                psi = a * z * z * sqrt_i * stable_sigma(y) / 3.0 + alpha - 0.5 * linear * ionic
                osmotic += molality * psi
            props.ln_g[i] = ln_gamma
            props.ln_a[i] = ln_gamma + molality.log()
        ln_aw = LN10 * WATER_MOLAR_MASS_KG_PER_MOL * osmotic
        props.ln_a[wi] = ln_aw
        props.ln_g[wi] = ln_aw - ln_xw
        return props
