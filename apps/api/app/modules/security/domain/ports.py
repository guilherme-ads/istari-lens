from __future__ import annotations

from typing import Protocol


class SecretsVaultPort(Protocol):
    def encrypt(self, plaintext: str) -> str:
        raise NotImplementedError

    def decrypt(self, ciphertext: str) -> str:
        raise NotImplementedError


