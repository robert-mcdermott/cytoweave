"""Remote control of a running CytoWeave (flow, spectral and mass cytometry analysis) from Python."""

from .client import CytoWeave, CytoWeaveError, Result, connect, default_data_dir, find_connection

__version__ = "0.8.1"

__all__ = ["CytoWeave", "CytoWeaveError", "Result", "connect", "default_data_dir", "find_connection", "__version__"]
