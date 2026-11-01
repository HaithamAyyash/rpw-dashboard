"""Prepare a stored MFCC matrix for the model."""
import numpy as np

FRAMES = 30
COEFFS = 13


class BadMeasurement(ValueError):
    """The matrix can't be classified. The database already enforces this, so seeing it is a bug."""


def preprocess(mfcc, stats=None):
    """Shape check, then per-coefficient normalization using the stats shipped with the model.
    stats is {'mean': [13 numbers], 'std': [13 numbers]}. The stub needs none."""
    matrix = np.asarray(mfcc, dtype=np.float32)
    if matrix.shape != (FRAMES, COEFFS):
        raise BadMeasurement(f'expected {FRAMES} x {COEFFS}, got {matrix.shape}')
    if not np.isfinite(matrix).all():
        raise BadMeasurement('matrix has non-finite values')
    if stats is None:
        return matrix
    mean = np.asarray(stats['mean'], dtype=np.float32)
    std = np.asarray(stats['std'], dtype=np.float32)
    if mean.shape != (COEFFS,) or std.shape != (COEFFS,) or (std == 0).any():
        raise BadMeasurement('bad normalization stats')
    return (matrix - mean) / std
