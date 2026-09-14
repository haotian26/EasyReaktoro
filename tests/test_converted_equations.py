"""Pure equation regressions runnable on Python 3.9 without Reaktoro installed.

Only the numeric helpers are exercised here. Reaktoro's actual property-model
integration is covered separately by test_rtdb_loader.
"""
import importlib.util
import math
from pathlib import Path
import sys
from types import ModuleType
import unittest
from unittest.mock import patch


def load_equations():
    path = Path(__file__).resolve().parents[1] / "bridge/easyreaktoro_runtime/converted_equations.py"
    spec = importlib.util.spec_from_file_location("converted_equations_numeric_test", path)
    module = importlib.util.module_from_spec(spec)
    try:
        import reaktoro
    except ImportError:
        # The pure helpers use no Reaktoro API. Keep this import-only stand-in
        # local so Python-version checks can run without installing an engine.
        with patch.dict(sys.modules, {"reaktoro": ModuleType("reaktoro")}):
            spec.loader.exec_module(module)
    else:
        spec.loader.exec_module(module)
    return module


equations = load_equations()


class ConvertedEquationNumericTest(unittest.TestCase):
    def test_cp_value_retains_all_ten_terms(self):
        coefficients = [3, .2, 5, .4, .006, .0007, .00008, 9, 2, .1]
        temperature = 4.0
        expected = (3 + .2*4 + 5/16 + .4/2 + .006*16 + .0007*64
                    + .00008*256 + 9/64 + 2/4 + .1*2)
        self.assertAlmostEqual(equations._cp_value(coefficients, temperature), expected)

    def test_cp_integrals_match_analytic_values_in_both_directions(self):
        coefficients = [30, .2] + [0]*8
        lower, upper = 300.0, 450.0
        expected = (30*(upper-lower) + .1*(upper**2-lower**2),
                    30*math.log(upper/lower) + .2*(upper-lower))
        for actual, value in zip(equations._cp_integrals(coefficients, lower, upper), expected):
            self.assertAlmostEqual(actual, value)
        for actual, value in zip(equations._cp_integrals(coefficients, upper, lower), expected):
            self.assertAlmostEqual(actual, -value)

    def test_cp_vectors_cannot_be_silently_truncated(self):
        for count in (0, 9, 11):
            with self.subTest(count=count):
                with self.assertRaisesRegex(ValueError, "different lengths"):
                    equations._cp_value([1]*count, 300)
                with self.assertRaisesRegex(ValueError, "different lengths"):
                    equations._cp_integrals([1]*count, 300, 450)

    def test_transition_pressure_shift_keeps_optional_zero_slopes(self):
        parameters = {"nEqu": 3, "T": [400, 600, 900], "dVdT": [10]}
        reference, shifted = equations._transition_boundaries(parameters, equations.P_REF + 2e8)
        self.assertEqual(reference, [400, 600])
        self.assertEqual(shifted, [420, 600])
        self.assertEqual(equations._transition_boundaries({"nEqu": 1, "T": [900]}, 1e5), ([], []))

    def test_missing_transition_temperature_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "different lengths"):
            equations._transition_boundaries({"nEqu": 3, "T": [400], "dVdT": [10, 20]}, 1e5)


if __name__ == "__main__":
    unittest.main()
