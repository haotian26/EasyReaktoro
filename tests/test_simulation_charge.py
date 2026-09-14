"""Recipes may be charged; the actual aggregate remains the equilibrium constraint."""
import unittest
from unittest.mock import patch
from tests.test_simulation import reaktoro
from tests.test_simulation_loops import plan
from tests.test_simulation_process import route
from tests.test_simulation_reactions import stages
from tests.test_simulation_round_pressure import mixed_plan
from bridge.easyreaktoro_runtime.simulation import Simulation
from bridge.easyreaktoro_runtime.simulation_jobs import database_source
from bridge.easyreaktoro_runtime.errors import BridgeError
from bridge.easyreaktoro_runtime.service import Service

@unittest.skipIf(reaktoro is None,'External Reaktoro required')
class AggregateChargeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service=Service();cls.handle=cls.service.handle(cls.service.open_official('SUPCRT','supcrtbl')['handle_id']);cls.source=database_source(cls.handle)
    @classmethod
    def tearDownClass(cls):cls.service.simulation_jobs.close()
    def run_plan(self,cfg):
        rows=[];Simulation({'config':cfg,'records':self.handle['records'],'source':self.source}).run(rows.append);return rows
    def charged_recipes(self):
        cfg=plan();cfg['materials']=[{'id':'cations','name':'Positive composition','inputs':[{'species':'H2O(aq)','amount':1,'unit':'kg'},{'species':'Na+','amount':.1,'unit':'mol'}]},{'id':'anions','name':'Negative composition','inputs':[{'species':'Cl-','amount':.1,'unit':'mol'}]}]
        cfg['reaction_stages']=stages(first_start=[route(id='positive',material_id='cations'),route(id='negative',material_id='anions')]);return cfg
    def test_separately_charged_compositions_mix_and_solve_without_modifying_their_amounts(self):
        row=self.run_plan(self.charged_recipes())[0]
        balances={b['component']:b for b in row['balances']}
        self.assertEqual(balances['charge']['input_mol'],0);self.assertLess(abs(balances['charge']['output_mol']),1e-10)
        for name in ('Na','Cl'):self.assertAlmostEqual(balances[name]['input_mol'],.1);self.assertAlmostEqual(balances[name]['output_mol'],.1)
        self.assertEqual(len(row['transfers']),2)
    def test_net_charge_in_actual_selected_inputs_is_blocked_without_adding_counterions(self):
        cfg=self.charged_recipes();cfg['reaction_stages']['first_start'].pop()
        with self.assertRaisesRegex(BridgeError,'本次汇合物料净电荷'):self.run_plan(cfg)
    def test_failed_optional_bootstrap_does_not_block_a_valid_full_equilibrium(self):
        cfg=mixed_plan();cfg['loops']['inner']={'mode':'repeat','count':1};cfg['loops']['outer']={'mode':'repeat','count':1};cfg['bootstrap']=True
        with patch.object(Simulation,'bootstrap',side_effect=BridgeError('TEST_GUESS','error.simulationFailed','Numerical guess unavailable')):
            row=self.run_plan(cfg)[0]
        self.assertEqual(row['summary']['initial_guess'],'cold');self.assertLess(row['summary']['max_component_balance_error_mol'],1e-10)
