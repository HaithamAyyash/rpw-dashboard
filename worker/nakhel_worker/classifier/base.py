"""The interface every model implements."""
from abc import ABC, abstractmethod
from typing import NamedTuple

import numpy as np

INFESTED_FROM = 0.5


class Prediction(NamedTuple):
    label: str          # 'healthy' or 'infested'
    confidence: float   # P(infested) between 0 and 1, whatever the label (decision A1)


def prediction_from_probability(probability):
    return Prediction('infested' if probability >= INFESTED_FROM else 'healthy', float(probability))


class Classifier(ABC):
    model_version: str

    @abstractmethod
    def predict(self, mfcc: np.ndarray) -> Prediction:
        """mfcc is the preprocessed 30 x 13 matrix."""
