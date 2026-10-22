from __future__ import annotations


class BridgeError(Exception):
    def __init__(self, code: str, message_key: str, diagnostic: str = "", *, location: dict | None = None) -> None:
        super().__init__(diagnostic or code)
        self.code = code
        self.message_key = message_key
        self.diagnostic = diagnostic or code
        self.location = location

    def response(self) -> dict:
        return {
            "ok": False,
            "error": {
                "code": self.code,
                "diagnostic": self.diagnostic,
                "message_key": self.message_key,
                **({"location": self.location} if self.location else {}),
            },
        }


def require(condition: bool, code: str, key: str, diagnostic: str) -> None:
    if not condition:
        raise BridgeError(code, key, diagnostic)
