"""Regression proof for benchmark verdicts; no browser or timing required."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
from performance_gate import assess

BUDGET = json.loads((ROOT / 'performance-budget.json').read_text())


def report():
    return {'results': [
        {'mode': mode, 'cpu_percent_one_core': cpu, 'cpu_samples': [cpu, cpu], 'pss_mib': memory}
        for mode, cpu, memory in [
            ('native_before', 10, 400), ('injected_disabled', 11, 402),
            ('enabled', 20, 425), ('disabled_after_use', 12, 415), ('native_after', 11, 405),
        ]
    ]}


class PerformanceGateTest(unittest.TestCase):
    def test_stable_cheap_run_passes(self):
        self.assertEqual(assess(report(), BUDGET)['status'], 'pass')

    def test_cpu_left_running_after_disable_fails(self):
        data = report(); data['results'][3]['cpu_percent_one_core'] = 25
        self.assertEqual(assess(data, BUDGET)['status'], 'fail')

    def test_active_cpu_budget_is_enforced(self):
        data = report(); data['results'][2]['cpu_percent_one_core'] = 40
        self.assertEqual(assess(data, BUDGET)['status'], 'fail')

    def test_retained_memory_budget_is_enforced(self):
        data = report(); data['results'][3]['pss_mib'] = 500
        self.assertEqual(assess(data, BUDGET)['status'], 'fail')

    def test_memory_retained_into_later_control_cannot_be_hidden(self):
        data = report()
        data['results'][3]['pss_mib'] = 500
        data['results'][-1]['pss_mib'] = 500
        self.assertEqual(assess(data, BUDGET)['status'], 'fail')

    def test_startup_or_background_drift_is_not_a_pass(self):
        data = report(); data['results'][-1]['cpu_percent_one_core'] = 30
        self.assertEqual(assess(data, BUDGET)['status'], 'inconclusive')

    def test_noisy_samples_are_inconclusive(self):
        data = report(); data['results'][2]['cpu_samples'] = [1, 40]
        self.assertEqual(assess(data, BUDGET)['status'], 'inconclusive')

    def test_one_scheduler_spike_does_not_hide_a_stable_median(self):
        data = report(); data['results'][0]['cpu_samples'] = [9, 10, 10, 40]
        self.assertEqual(assess(data, BUDGET)['status'], 'pass')

    def test_missing_memory_or_phases_are_inconclusive(self):
        data = report(); data['results'][0]['pss_mib'] = None
        self.assertEqual(assess(data, BUDGET)['status'], 'inconclusive')
        data = report(); data['results'].pop()
        self.assertEqual(assess(data, BUDGET)['status'], 'inconclusive')


if __name__ == '__main__':
    unittest.main()
