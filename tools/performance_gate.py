"""Assess a paired local benchmark; noisy measurements never pass the gate."""


def assess(report, budget):
    modes = {row['mode']: row for row in report['results']}
    required = {'native_before', 'injected_disabled', 'enabled', 'disabled_after_use', 'native_after'}
    if not required <= modes.keys():
        return {'status': 'inconclusive', 'reasons': ['Missing benchmark phases']}
    before, after = modes['native_before'], modes['native_after']
    reasons = []
    if abs(before['cpu_percent_one_core'] - after['cpu_percent_one_core']) > budget['baseline_drift_cpu_points']:
        reasons.append('Native playback baselines drifted too far apart')
    for name in required:
        samples = modes[name].get('cpu_samples', [])
        central = sorted(samples)[1:-1] if len(samples) >= 4 else samples
        if len(samples) < 2 or max(central) - min(central) > budget['sample_drift_cpu_points']:
            reasons.append(f'Unstable CPU samples: {name}')
        if modes[name].get('pss_mib') is None:
            reasons.append(f'Memory measurement unavailable: {name}')
    if reasons:
        return {'status': 'inconclusive', 'reasons': reasons}
    baseline_cpu = max(before['cpu_percent_one_core'], after['cpu_percent_one_core'])
    # Retained allocations also affect the later native control. Using that
    # control as a memory baseline would conceal a persistent memory increase.
    baseline_memory = before['pss_mib']
    for name in ['injected_disabled', 'disabled_after_use', 'enabled', 'native_after']:
        row = modes[name]
        allowed = budget['enabled_cpu_overhead_points'] if name == 'enabled' else budget['disabled_cpu_overhead_points']
        if row['cpu_percent_one_core'] - baseline_cpu > allowed:
            reasons.append(f'CPU budget exceeded: {name}')
        if row['pss_mib'] - baseline_memory > budget['memory_overhead_mib']:
            reasons.append(f'Memory budget exceeded: {name}')
    return {'status': 'fail' if reasons else 'pass', 'reasons': reasons, 'baseline_cpu_percent_one_core': baseline_cpu, 'baseline_pss_mib': baseline_memory}
