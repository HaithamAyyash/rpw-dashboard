"""Tree status bands. Mirrors the node_status view; a test checks the two always agree."""
HEALTHY, SUSPECTED, ALERT = 'healthy', 'suspected', 'alert'
RANK = {HEALTHY: 0, SUSPECTED: 1, ALERT: 2}


def band(average, suspect_threshold, alert_threshold):
    """Which band a last-3 average falls in, using that organization's thresholds."""
    if average is None or average < suspect_threshold:
        return HEALTHY
    return ALERT if average >= alert_threshold else SUSPECTED
