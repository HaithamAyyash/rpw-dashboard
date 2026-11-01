"""Plausible MFCC matrices, SNR gating and FAKE classifier scores. For testing software only."""
import numpy as np

MFCC_FRAMES = 30
MFCC_COEFFS = 13

# Fraction of wake-ups passing the node's SNR > 4 dB gate. Assumption; see DECISIONS.md.
SEND_RATE = {'healthy': 0.10, 'suspected': 0.50, 'infested': 0.90}


# How much c0 varies between frames, by condition.
C0_SPREAD = {'healthy': 6.0, 'suspected': 15.0, 'infested': 30.0}


def fake_mfcc(rng, infested, c0_spread=None):
    """A 30 x 13 matrix: larvae bouts raise c0 and make it vary between frames."""
    decay = 40.0 / (1 + np.arange(MFCC_COEFFS))
    matrix = rng.normal(0.0, 1.0, (MFCC_FRAMES, MFCC_COEFFS)) * (decay / 8) + decay
    if infested:
        matrix[:, 0] = rng.normal(-235.0, c0_spread or C0_SPREAD['infested'], MFCC_FRAMES)
    else:
        matrix[:, 0] = rng.normal(-320.0, c0_spread or C0_SPREAD['healthy'], MFCC_FRAMES)
    return matrix.astype(np.float32)


def pg_array_literal(matrix):
    """The Postgres text form of a 2-D array, usable in COPY."""
    rows = (','.join(f'{value:.3f}' for value in row) for row in matrix)
    return '{' + ','.join('{' + row + '}' for row in rows) + '}'


def literal_pool(rng, infested, size):
    """Ready-rendered matrices. The large seed reuses these: formatting 390 numbers for
    every row would dominate its run time and wouldn't change query speed."""
    return [pg_array_literal(fake_mfcc(rng, infested)) for _ in range(size)]


def confidence_curve(condition, progress, rng):
    """FAKE P(infested). progress runs 0 to 1 from the start of an infestation to now."""
    noise = rng.normal(0, 0.03)
    if condition == 'healthy':
        value = rng.beta(1.2, 18)
    elif condition == 'suspected':
        value = 0.08 + 0.57 * progress + noise
    else:
        value = 0.08 + 0.87 * progress + noise
    return float(min(max(value, 0.0), 1.0))
