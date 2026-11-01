"""A FAKE classifier so the pipeline works before the real model exists. It detects nothing."""
import math

import numpy as np

from .base import Classifier, Prediction, prediction_from_probability

MIDPOINT = 15.0  # c0 standard deviation that scores 0.5
STEEPNESS = 3.0


class StubClassifier(Classifier):
    """A deterministic score from how much c0 varies across frames. The FAKE in model_version
    reaches the dashboard, so its results can't be mistaken for a real model's."""
    model_version = 'stub-0.1-FAKE'

    def predict(self, mfcc: np.ndarray) -> Prediction:
        spread = float(np.std(mfcc[:, 0]))
        return prediction_from_probability(1 / (1 + math.exp(-(spread - MIDPOINT) / STEEPNESS)))
