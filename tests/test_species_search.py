import copy
import unittest
from bridge.easyreaktoro_runtime.species_search import search_records


def record(name, formula, state='Aqueous', model='HKF', composition=None):
    return {'name': name, 'formula': formula, 'state': state, 'model': {'type': model},
            'composition': composition or {}, 'provenance': {}}


class SpeciesSearchTests(unittest.TestCase):
    def test_exact_formula_name_and_prefix_precede_substring_without_mutating_database(self):
        rows = [record('H2O2(aq)', 'H2O2'), record('prefix-H2O', 'x'), record('Water', 'H2O'), record('H2O(aq)', 'H2O')]
        original = copy.deepcopy(rows)
        self.assertEqual([r['name'] for r in search_records(rows, {'query': 'H₂O'})], ['H2O(aq)', 'Water', 'H2O2(aq)', 'prefix-H2O'])
        self.assertEqual(rows, original)

    def test_element_case_is_ranked_correctly_without_preventing_forgiving_search(self):
        rows = [record('Cobalt', 'Co'), record('Carbon monoxide', 'CO')]
        self.assertEqual(search_records(rows, {'query': 'CO'})[0]['name'], 'Carbon monoxide')
        self.assertEqual(search_records(rows, {'query': 'Co'})[0]['name'], 'Cobalt')

    def test_alias_multi_term_and_intersecting_filters_are_consistent(self):
        a = record('sodium chloride', 'NaCl', composition={'Na': 1, 'Cl': 1})
        a['original_name'] = 'halite-aq'
        b = record('Halite', 'NaCl', 'Solid', 'HollandPowell', {'Na': 1, 'Cl': 1})
        c = record('Na+', 'Na+', composition={'Na': 1})
        self.assertEqual(search_records([a,b,c], {'query': 'halite HKF', 'state': 'Aqueous', 'elements': ['Na','Cl'], 'model': 'HKF'}), [a])
        self.assertEqual(search_records([a,b,c], {'query': 'Na', 'elements': ['Na','Cl'], 'model': 'HollandPowell'}), [b])
