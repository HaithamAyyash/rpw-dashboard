"""Classifiers. Swapping the model means adding a Classifier here; nothing else changes."""
from .base import Classifier, Prediction
from .stub import StubClassifier

__all__ = ['Classifier', 'Prediction', 'StubClassifier']
