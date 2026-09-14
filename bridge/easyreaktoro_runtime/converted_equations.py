"""Versioned, data-driven standard-state equations for Reaktoro 2.13.

The functions in this module consume only parameters extracted from the
native thermodynamic records. They do not use sampled property grids.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterator, Sequence
from typing import Any

import reaktoro as rkt


T_REF = 298.15
P_REF = 1.0e5
R = 8.31446261815324
LN10 = math.log(10.0)
R_AD = 8.31451
R_AD_CM3_BAR = 83.1451
WATER_MOLAR_MASS_G = 18.01528
# Converted/ThermoFun empirical Cp order:
# a + bT + c/T2 + d/sqrt(T) + eT2 + fT3 + gT4 + h/T3 + i/T + j*sqrt(T)
CP_EXPONENTS = (0.0, 1.0, -2.0, -0.5, 2.0, 3.0, 4.0, -3.0, -1.0, 0.5)


def _props(
    G: float,
    H: float,
    V: float,
    Cp: float,
    VT: float = 0.0,
    VP: float = 0.0,
) -> rkt.StandardThermoProps:
    result = rkt.StandardThermoProps()
    result.G0 = G
    result.H0 = H
    result.V0 = V
    result.Cp0 = Cp
    result.VT0 = VT
    result.VP0 = VP
    return result


def _power_integral(coefficient: float, exponent: float, a: float, b: float) -> float:
    if coefficient == 0.0 or a == b:
        return 0.0
    power = exponent + 1.0
    if abs(power) < 1.0e-14:
        return coefficient * math.log(b / a)
    return coefficient * (b**power - a**power) / power


def _zip_equal(
    left: Sequence[float], right: Sequence[float]
) -> Iterator[tuple[float, float]]:
    """Pair parameter vectors without truncation, including on Python 3.9."""
    if len(left) != len(right):
        raise ValueError(
            f"Thermodynamic parameter arrays have different lengths ({len(left)} and {len(right)})"
        )
    return zip(left, right)


def _cp_value(coefficients: list[float], temperature: float) -> float:
    return sum(
        coefficient * temperature**exponent
        for coefficient, exponent in _zip_equal(coefficients, CP_EXPONENTS)
    )


def _cp_integrals(
    coefficients: list[float], lower: float, upper: float
) -> tuple[float, float]:
    integral_cp = 0.0
    integral_cp_over_t = 0.0
    for coefficient, exponent in _zip_equal(coefficients, CP_EXPONENTS):
        integral_cp += _power_integral(coefficient, exponent, lower, upper)
        integral_cp_over_t += _power_integral(
            coefficient, exponent - 1.0, lower, upper
        )
    return integral_cp, integral_cp_over_t


def _phase_intervals(parameters: dict[str, Any]) -> list[tuple[float, float]]:
    count = int(parameters["nEqu"])
    upper = [float(value) for value in parameters["T"][:count]]
    intervals: list[tuple[float, float]] = []
    lower = 0.0
    for boundary in upper:
        intervals.append((lower, boundary if boundary > 0.0 else math.inf))
        lower = boundary
    if intervals:
        intervals[-1] = (intervals[-1][0], math.inf)
    return intervals


def _cp_rows(parameters: dict[str, Any]) -> list[list[float]]:
    count = int(parameters["nEqu"])
    raw = [float(value) for value in parameters["Cp"]]
    return [
        (raw[index * 10 : index * 10 + 10] + [0.0] * 10)[:10]
        for index in range(count)
    ]


def _transition_boundaries(
    parameters: dict[str, Any], pressure: float
) -> tuple[list[float], list[float]]:
    """Return reference and pressure-shifted transition temperatures.

    The source record stores the boundary slope in K/kbar. Only boundaries separating two
    Cp equations are transitions; the final T value is the existence limit.
    """
    count = max(int(parameters["nEqu"]) - 1, 0)
    reference = [
        float(value) for value in parameters["T"][:count]
    ]
    slopes = (
        [float(value) for value in parameters.get("dVdT", [])[:count]]
        + [0.0] * count
    )[:count]
    pressure_offset_kbar = (pressure - P_REF) / 1.0e8
    shifted = [
        boundary + slope * pressure_offset_kbar
        for boundary, slope in _zip_equal(reference, slopes)
    ]
    return reference, shifted


def _active_phase_index(
    parameters: dict[str, Any], temperature: float, pressure: float
) -> int:
    rows = _cp_rows(parameters)
    if not rows:
        return 0
    _, shifted = _transition_boundaries(parameters, pressure)
    index = sum(temperature > boundary for boundary in shifted)
    return min(index, len(rows) - 1)


def _integrate_piecewise_cp(
    parameters: dict[str, Any], temperature: float, pressure: float
) -> tuple[float, float, float, float, float]:
    """Return branch Cp integrals and transition H/S at T and P.

    Thermodynamic branches remain anchored to the 1-bar transition
    temperatures. Pressure changes which branch is stable through dT/dP.
    """
    rows = _cp_rows(parameters)
    if not rows:
        return 0.0, 0.0, 0.0, 0.0, 0.0
    reference_boundaries, _ = _transition_boundaries(
        parameters, pressure
    )
    selected = _active_phase_index(parameters, temperature, pressure)
    cp_int = 0.0
    cpt_int = 0.0
    transition_h = 0.0
    transition_s = 0.0
    lower = T_REF
    for index in range(selected):
        boundary = reference_boundaries[index]
        part_cp, part_cpt = _cp_integrals(
            rows[index], lower, boundary
        )
        cp_int += part_cp
        cpt_int += part_cpt
        raw_dh = float(parameters["dH"][index])
        if abs(raw_dh) < 9.0e8:
            transition_h += raw_dh
            transition_s += raw_dh / boundary
        lower = boundary
    part_cp, part_cpt = _cp_integrals(
        rows[selected], lower, temperature
    )
    cp_int += part_cp
    cpt_int += part_cpt

    return (
        cp_int,
        cpt_int,
        _cp_value(rows[selected], temperature),
        transition_h,
        transition_s,
    )


def pure_phase_model(parameters: dict[str, Any], is_gas: bool) -> rkt.StandardThermoModel:
    """Create the extended-Cp pure-phase standard-state model."""
    reference_g = float(parameters["Param"][0])
    reference_s = float(parameters["Param"][1])
    reference_v = 0.0 if is_gas else float(parameters["Param"][2]) * 1.0e-5

    def evaluate(T: Any, P: Any) -> rkt.StandardThermoProps:
        temperature = float(T)
        pressure = float(P)
        cp_int, cpt_int, cp, transition_h, transition_s = (
            _integrate_piecewise_cp(
                parameters, temperature, pressure
            )
        )
        volume = reference_v
        if not is_gas:
            selected = _active_phase_index(
                parameters, temperature, pressure
            )
            for index in range(selected):
                delta_v = float(parameters["dV"][index])
                if delta_v > -0.999:
                    volume += delta_v * 1.0e-5
        entropy = reference_s + cpt_int + transition_s
        gibbs = (
            reference_g
            - reference_s * (temperature - T_REF)
            + cp_int
            - temperature * cpt_int
            + transition_h
            - temperature * transition_s
            + (pressure - P_REF) * volume
        )
        enthalpy = gibbs + temperature * entropy
        return _props(gibbs, enthalpy, volume, cp)

    return rkt.StandardThermoModel(evaluate)


def _real_gas_reference_props(
    parameters: dict[str, Any], temperature: float
) -> rkt.StandardThermoProps:
    """Evaluate the ideal-standard-gas reference Cp equation."""
    reference_g = float(parameters["Param"][0])
    reference_s = float(parameters["Param"][1])
    count = int(parameters["nCp"])
    coefficients = (
        [float(value) for value in parameters["Cp"][:count]] + [0.0] * 10
    )[:10]

    cp_int, cpt_int = _cp_integrals(
        coefficients, T_REF, temperature
    )
    entropy = reference_s + cpt_int
    gibbs = (
        reference_g
        - reference_s * (temperature - T_REF)
        + cp_int
        - temperature * cpt_int
    )
    enthalpy = gibbs + temperature * entropy
    return _props(
        gibbs,
        enthalpy,
        0.0,
        _cp_value(coefficients, temperature),
    )


def real_gas_reference_model(parameters: dict[str, Any]) -> rkt.StandardThermoModel:
    """Create the ideal-standard-gas part of a real-gas record.

    PRSV fugacity parameters are deliberately not folded into standard-state
    properties. They remain available through gas_model_parameters().
    """

    def evaluate(T: Any, P: Any) -> rkt.StandardThermoProps:
        del P
        return _real_gas_reference_props(parameters, float(T))

    return rkt.StandardThermoModel(evaluate)


def _water_ideal_gas_woolley(
    temperature: float, reference_offsets: dict[str, float],
) -> tuple[float, float, float, float]:
    """Return G, H, S, Cp for ideal-gas H2O using Woolley (1979)."""
    coefficients = (
        19.730271018,
        20.9662681977,
        -0.483429455355,
        6.05743189245,
        22.56023885,
        -9.87532442,
        -4.3135538513,
        0.458155781,
        -0.047754901883,
        0.0041238460633,
        -0.00027929052852,
        0.000014481695261,
        -0.00000056473658748,
        0.000000016200446,
        -0.0000000003303822796,
        0.00000000000451916067368,
        -0.0000000000000370734122708,
        0.000000000000000137546068238,
    )
    reduced = temperature / 100.0
    log_reduced = math.log(reduced)
    dimensionless_g = -(
        coefficients[0] / reduced + coefficients[1]
    ) * log_reduced
    dimensionless_h = coefficients[1] + coefficients[0] * (
        1.0 - log_reduced
    ) / reduced
    dimensionless_cp = coefficients[1] - coefficients[0] / reduced
    for index in range(2, 18):
        multiplier = reduced ** (index - 5)
        dimensionless_g -= coefficients[index] * multiplier
        dimensionless_h += (
            coefficients[index] * (index - 5) * multiplier
        )
        dimensionless_cp += (
            coefficients[index]
            * (index - 5)
            * (index - 4)
            * multiplier
        )
    enthalpy_zero_K = -182161.88
    gibbs = (
        dimensionless_g * R_AD * temperature + enthalpy_zero_K
    )
    enthalpy = (
        dimensionless_h * R_AD * temperature + enthalpy_zero_K
    )
    entropy = (
        dimensionless_h - dimensionless_g
    ) * R_AD
    cp = dimensionless_cp * R_AD
    # Convert the Woolley reference constants to the record convention.
    gibbs += reference_offsets["ideal_water_dH_J_mol"] - temperature * reference_offsets["ideal_water_dS_J_mol_K"]
    enthalpy += reference_offsets["ideal_water_dH_J_mol"]
    entropy += reference_offsets["ideal_water_dS_J_mol_K"]
    return gibbs, enthalpy, entropy, cp


def _water_ad_inputs(
    temperature: float, pressure: float, reference_offsets: dict[str, float]
) -> tuple[float, float, float, float, float, float, float]:
    """Return water G, S, Cp, rho, alpha, beta_bar, and d(alpha)/dT."""
    standard = water_standard_props(temperature, pressure)
    state = rkt.waterThermoPropsHGK(
        temperature,
        max(pressure, 1.0),
        rkt.StateOfMatter.Liquid,
    )
    density_kg_m3 = float(state.D)
    density_g_cm3 = density_kg_m3 / 1000.0
    alpha = -float(state.DT) / density_kg_m3
    beta_bar = float(state.DP) / density_kg_m3 * 1.0e5
    alpha_temperature_derivative = (
        -float(state.DTT) / density_kg_m3 + alpha**2
    )
    # Convert Reaktoro's HGK-water reference constants to the record convention.
    # Density and all state derivatives stay those of the HGK equation.
    gibbs = (
        float(standard.G0)
        + reference_offsets["water_dH_J_mol"]
        - temperature * reference_offsets["water_dS_J_mol_K"]
    )
    enthalpy = float(standard.H0) + reference_offsets["water_dH_J_mol"]
    entropy = (enthalpy - gibbs) / temperature
    return (
        gibbs,
        entropy,
        float(standard.Cp0),
        density_g_cm3,
        alpha,
        beta_bar,
        alpha_temperature_derivative,
    )


def _akinfiev_diamond_increment(
    temperature: float,
    pressure: float,
    xi: float,
    coefficient_a: float,
    coefficient_b: float,
    reference_offsets: dict[str, float],
) -> tuple[float, float, float, float, float]:
    """Return hydration G, V(J/bar), S, Cp, and H from AD (2003)."""
    (
        water_g,
        water_s,
        water_cp,
        density,
        alpha,
        beta_bar,
        alpha_temperature_derivative,
    ) = _water_ad_inputs(temperature, pressure, reference_offsets)
    ideal_g, _, ideal_s, ideal_cp = _water_ideal_gas_woolley(
        temperature, reference_offsets
    )
    residual_g = water_g - ideal_g
    residual_s = water_s - ideal_s
    residual_cp = water_cp - ideal_cp
    log_fugacity = residual_g / (R_AD * temperature)
    molar_volume_cm3 = WATER_MOLAR_MASS_G / density
    density_t = -alpha * density
    density_p_bar = beta_bar * density
    density_tt = density * (
        alpha**2 - alpha_temperature_derivative
    )
    sqrt_term = math.sqrt(1000.0 / temperature)

    gibbs = (
        -R_AD
        * temperature
        * math.log(1000.0 / WATER_MOLAR_MASS_G)
        + (1.0 - xi)
        * R_AD
        * temperature
        * log_fugacity
        + R_AD
        * temperature
        * xi
        * math.log(
            R_AD_CM3_BAR
            * temperature
            / WATER_MOLAR_MASS_G
            * density
        )
        + R_AD
        * temperature
        * density
        * (coefficient_a + coefficient_b * sqrt_term)
    )
    pressure_derivative = (
        coefficient_a * temperature * density_p_bar
        + coefficient_b
        * 10.0**1.5
        * temperature**0.5
        * density_p_bar
    )
    temperature_derivative = (
        coefficient_a
        * (density + temperature * density_t)
        + coefficient_b
        * (
            0.5
            * 10.0**1.5
            * temperature**-0.5
            * density
            + 10.0**1.5
            * temperature**0.5
            * density_t
        )
    )
    second_temperature_derivative = (
        coefficient_a
        * (2.0 * density_t + temperature * density_tt)
        + coefficient_b
        * (
            -0.25
            * 10.0**1.5
            * temperature**-1.5
            * density
            + 10.0**1.5
            * temperature**-0.5
            * density_t
            + 10.0**1.5
            * temperature**0.5
            * density_tt
        )
    )
    volume_j_bar = (
        molar_volume_cm3 * (1.0 - xi)
        + xi
        * R_AD_CM3_BAR
        * temperature
        / density
        * density_p_bar
        + R_AD_CM3_BAR * pressure_derivative
    ) / 10.0
    entropy = (
        (1.0 - xi) * residual_s
        + R_AD * math.log(1000.0 / WATER_MOLAR_MASS_G)
        - R_AD
        * (
            xi
            + xi
            * math.log(
                R_AD_CM3_BAR
                * temperature
                / WATER_MOLAR_MASS_G
            )
            + xi * math.log(density)
            + xi
            * temperature
            / density
            * density_t
        )
        - R_AD * temperature_derivative
    )
    cp = (
        (1.0 - xi) * residual_cp
        - R_AD
        * (
            xi
            + 2.0
            * xi
            * temperature
            / density
            * density_t
            - xi
            * temperature**2
            / density**2
            * density_t**2
            + xi
            * temperature**2
            / density
            * density_tt
        )
        - R_AD
        * temperature
        * second_temperature_derivative
    )
    enthalpy = gibbs + temperature * entropy
    return gibbs, volume_j_bar, entropy, cp, enthalpy


def akinfiev_diamond_model(
    parameters: dict[str, Any],
) -> rkt.StandardThermoModel:
    """Create the Akinfiev-Diamond aqueous-nonelectrolyte model."""
    xi, coefficient_a, coefficient_b = (
        float(value) for value in parameters["Param"][3:6]
    )

    def evaluate(T: Any, P: Any) -> rkt.StandardThermoProps:
        temperature = float(T)
        pressure = float(P)
        base = _real_gas_reference_props(parameters, temperature)
        hydration_g, hydration_v, hydration_s, hydration_cp, hydration_h = (
            _akinfiev_diamond_increment(
                temperature,
                pressure,
                xi,
                coefficient_a,
                coefficient_b,
                parameters["reference_offsets"],
            )
        )
        base_s = (float(base.H0) - float(base.G0)) / temperature
        # The converted equation directly adds the AD hydration increment to the ideal-gas
        # reference properties. It does not apply ThermoFun's optional
        # 298.15 K hydration renormalization.
        gibbs = float(base.G0) + hydration_g
        entropy = base_s + hydration_s
        enthalpy = float(base.H0) + hydration_h
        cp = float(base.Cp0) + hydration_cp
        return _props(
            gibbs,
            enthalpy,
            hydration_v * 1.0e-5,
            cp,
        )

    return rkt.StandardThermoModel(evaluate)


def water_model() -> rkt.StandardThermoModel:
    """Return Reaktoro's installed HKF liquid-water standard-state model."""
    return rkt.StandardThermoModelWaterHKF(
        rkt.StandardThermoModelParamsWaterHKF()
    )


def water_standard_props(
    temperature: float, pressure: float
) -> rkt.StandardThermoProps:
    """Evaluate the same HGK/HKF liquid-water convention without model nesting."""
    state = rkt.waterThermoPropsHGK(
        temperature,
        max(pressure, 1.0),
        rkt.StateOfMatter.Liquid,
    )
    molar_mass = 0.01801528
    triple_temperature = 273.16
    triple_entropy = 63.312288
    triple_gibbs = -235517.36
    triple_enthalpy = -287721.128
    water_enthalpy = float(state.H) * molar_mass
    water_entropy = float(state.S) * molar_mass
    entropy = water_entropy + triple_entropy
    enthalpy = water_enthalpy + triple_enthalpy
    gibbs = (
        water_enthalpy
        - temperature * entropy
        + triple_temperature * triple_entropy
        + triple_gibbs
    )
    volume = float(state.V) * molar_mass
    cp = float(state.Cp) * molar_mass
    return _props(gibbs, enthalpy, volume, cp)


def _water_density_g_cm3(temperature: float, pressure: float) -> float:
    density = rkt.waterDensityHGK(
        temperature,
        max(pressure, 1.0),
        rkt.StateOfMatter.Liquid,
    )
    return max(float(density) / 1000.0, 1.0e-12)


def marshall_franck_pkw(temperature: float, pressure: float) -> float:
    """Marshall-Franck water ion product used by the MRB equation."""
    rho = _water_density_g_cm3(temperature, pressure)
    a, b, c, d = -4.098, -3245.2, 2.2362e5, -3.984e7
    e, f, g = 13.957, -1262.3, 8.5641e5
    value = (
        a
        + b / temperature
        + c / temperature**2
        + d / temperature**3
        + (e + f / temperature + g / temperature**2) * math.log10(rho)
    )
    return -value


def mrb_pk(
    temperature: float,
    pressure: float,
    pK0: float,
    Azz: float,
    Bzz: float,
) -> float:
    rho_ref = 0.997061
    a, b, c, d = -4.098, -3245.2, 2.2362e5, -3.984e7
    e, f, g = 13.957, -1262.3, 8.5641e5
    pkw_ref = -(
        a
        + b / T_REF
        + c / T_REF**2
        + d / T_REF**3
        + (e + f / T_REF + g / T_REF**2) * math.log10(rho_ref)
    )
    pkw = marshall_franck_pkw(temperature, pressure)
    solvent_term = (pkw - pkw_ref * T_REF / temperature) / 1.0107
    return (
        float(pK0) * T_REF / temperature
        + (float(Azz) + float(Bzz) / temperature) * solvent_term
    )


def _differentiate_gibbs(
    gibbs: Callable[[float, float], float],
    temperature: float,
    pressure: float,
) -> rkt.StandardThermoProps:
    dt = max(1.0e-2, abs(temperature) * 1.0e-4)
    dp = max(100.0, abs(pressure) * 1.0e-4)
    tminus = max(temperature - dt, 1.0)
    tplus = temperature + dt
    g0 = gibbs(temperature, pressure)
    gm = gibbs(tminus, pressure)
    gp = gibbs(tplus, pressure)
    first_t = (gp - gm) / (tplus - tminus)
    half_span = 0.5 * (tplus - tminus)
    second_t = (gp - 2.0 * g0 + gm) / (half_span * half_span)
    pm = max(pressure - dp, 1.0)
    pp = pressure + dp
    gpm = gibbs(temperature, pm)
    gpp = gibbs(temperature, pp)
    first_p = (gpp - gpm) / (pp - pm)
    half_p = 0.5 * (pp - pm)
    second_p = (gpp - 2.0 * g0 + gpm) / (half_p * half_p)
    entropy = -first_t
    enthalpy = g0 + temperature * entropy
    cp = -temperature * second_t
    return _props(g0, enthalpy, first_p, cp, 0.0, second_p)


def hydroxide_standard_props(
    temperature: float, pressure: float
) -> rkt.StandardThermoProps:
    """Derived OH- record based on water and the Marshall-Franck pKw."""

    def gibbs(temperature: float, pressure: float) -> float:
        water_g = float(water_standard_props(temperature, pressure).G0)
        return (
            water_g
            + R
            * temperature
            * LN10
            * marshall_franck_pkw(temperature, pressure)
        )

    return _differentiate_gibbs(gibbs, temperature, pressure)


def hydroxide_model() -> rkt.StandardThermoModel:
    def evaluate(T: Any, P: Any) -> rkt.StandardThermoProps:
        return hydroxide_standard_props(float(T), float(P))

    return rkt.StandardThermoModel(evaluate)

def complex_model(
    parameters: dict[str, Any],
    reactants: list[
        tuple[float, Callable[[float, float], rkt.StandardThermoProps]]
    ],
) -> rkt.StandardThermoModel:
    """Create a modified Ryzhenko-Bryzgalin complex model."""
    pK0 = float(parameters["pK0"])
    Azz = float(parameters["Azz"])
    Bzz = float(parameters["Bzz"])

    def gibbs(temperature: float, pressure: float) -> float:
        reactant_g = sum(
            coefficient
            * float(evaluate(temperature, pressure).G0)
            for coefficient, evaluate in reactants
        )
        pk = mrb_pk(temperature, pressure, pK0, Azz, Bzz)
        return reactant_g - R * temperature * LN10 * pk

    def evaluate(T: Any, P: Any) -> rkt.StandardThermoProps:
        return _differentiate_gibbs(gibbs, float(T), float(P))

    return rkt.StandardThermoModel(evaluate)
