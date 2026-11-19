#!/usr/bin/python3
"""Store one PTO Calendar agent credential in the Linux Secret Service.

This helper is a fixed, bundled program. It is started as

    /usr/bin/python3 -I -B secret-service.py

with one JSON request on stdin, and it answers with exactly one JSON object on
stdout. While a request is handled, file descriptor 1 is pointed at standard
error, so anything a binding writes to stdout cannot corrupt the answer. No
traceback is ever printed, and a credential never appears in an argument, in
the environment or in a message.

The helper never starts the secret service. Before the service is opened, a
proxy created with both DO_NOT_AUTO_START flags checks that the service already
owns its bus name, so neither the proxy nor a lookup can activate a service that
would then ask for an unlock or show a prompt.

The lookup path never unlocks and never prompts. It searches every exact match
with Secret.SearchFlags.ALL only, refuses an ambiguous or a locked match,
checks the scope of the one match it selected and loads that item's secret.
Secret.Item.create_sync may ask the service to prompt when an explicit set
creates a new item, and Secret.Item.delete_sync may ask the service to prompt
when an explicit remove deletes an item. Neither happens on the lookup path.
"""

import json
import os
import re
import sys
from collections import namedtuple

# The request is one JSON object. A larger one is refused before it is parsed.
MAX_REQUEST_BYTES = 4096

# The answer is one JSON object. A larger one is replaced by a fixed failure.
MAX_RESPONSE_BYTES = 4096

# The longest origin the caller may send. It is the same bound the caller uses.
MAX_ORIGIN_LENGTH = 512

# The schema name is the namespace of this application inside the secret
# service. The schema name and the namespace attribute are both matched, so a
# record of another application is never found, changed or removed.
SCHEMA_NAME = "org.pto-calendar.agent-auth"
NAMESPACE = "pto-calendar"

# The well-known name of the secret service and the interface that it exports.
SERVICE_NAME = "org.freedesktop.secrets"
SERVICE_PATH = "/org/freedesktop/secrets"
SERVICE_INTERFACE = "org.freedesktop.Secret.Service"

# The fixed codes of this protocol. A caller maps them onto its own error
# surface, and no other code is ever produced.
CODE_UNSUPPORTED = "unsupported"
CODE_UNAVAILABLE = "unavailable"
CODE_LOCKED = "locked"
CODE_AMBIGUOUS = "ambiguous"
CODE_FAILED = "failed"

# The exact normalized forms that the caller writes. A default port never
# appears in them, and plain HTTP is admitted only for a loopback host.
PROFILE_PATTERN = re.compile(r"[a-z0-9][a-z0-9_-]{0,31}")
ORIGIN_PATTERN = re.compile(
    r"(https?)://(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([1-9][0-9]{0,4}))?"
)
TOKEN_PATTERN = re.compile(
    r"pto_pat_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{64}"
)
LOOPBACK_HOSTS = frozenset(("127.0.0.1", "[::1]", "localhost"))

Bindings = namedtuple("Bindings", ("Secret", "Gio"))


class HelperError(Exception):
    """A failure that carries one fixed, safe code."""

    code = CODE_FAILED


class UnsupportedError(HelperError):
    """The platform has no usable Secret Service binding."""

    code = CODE_UNSUPPORTED


class UnavailableError(HelperError):
    """The secret service is not running, could not be reached or was lost."""

    code = CODE_UNAVAILABLE


class LockedError(HelperError):
    """The matching record or its collection is locked."""

    code = CODE_LOCKED


class AmbiguousError(HelperError):
    """More than one record matches the requested scope."""

    code = CODE_AMBIGUOUS


def failure(code):
    """Return the fixed answer of a failure."""
    return {"status": "error", "code": code}


def emit(payload):
    """Write exactly one bounded JSON object to stdout."""
    data = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    if len(data) > MAX_RESPONSE_BYTES:
        data = json.dumps(failure(CODE_FAILED), separators=(",", ":"))
    sys.stdout.write(data)
    sys.stdout.flush()


def load_bindings():
    """Return the Secret Service and Gio bindings, or report them unsupported."""
    try:
        import gi

        gi.require_version("Secret", "1")
        gi.require_version("Gio", "2.0")
        from gi.repository import Gio, Secret
    except Exception:
        raise UnsupportedError()
    return Bindings(Secret=Secret, Gio=Gio)


def read_request():
    """Read one bounded JSON object from stdin."""
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    except Exception:
        raise HelperError()
    if len(raw) > MAX_REQUEST_BYTES:
        raise HelperError()
    try:
        request = json.loads(raw.decode("utf-8"))
    except Exception:
        raise HelperError()
    if not isinstance(request, dict):
        raise HelperError()
    return request


def checked_origin(origin):
    """Accept only the exact normalized origin, with a loopback host for plain HTTP."""
    if len(origin) > MAX_ORIGIN_LENGTH:
        raise HelperError()
    matched = ORIGIN_PATTERN.fullmatch(origin)
    if matched is None:
        raise HelperError()
    scheme, host, port = matched.groups()
    if port is not None and int(port) > 65535:
        raise HelperError()
    if (scheme, port) in (("https", "443"), ("http", "80")):
        raise HelperError()
    if scheme == "http" and host not in LOOPBACK_HOSTS:
        raise HelperError()
    return origin


def checked_request(request):
    """Return the checked operation, profile, origin and token of one request.

    The request has exactly the fields of its operation. Anything else is refused.
    """
    op = request.get("op")
    if op == "set":
        fields = {"op", "profile", "origin", "token"}
    elif op in ("get", "remove"):
        fields = {"op", "profile", "origin"}
    else:
        raise HelperError()
    if set(request) != fields:
        raise HelperError()
    profile = request["profile"]
    origin = request["origin"]
    if not isinstance(profile, str) or PROFILE_PATTERN.fullmatch(profile) is None:
        raise HelperError()
    if not isinstance(origin, str):
        raise HelperError()
    checked_origin(origin)
    token = None
    if op == "set":
        token = request["token"]
        if not isinstance(token, str) or TOKEN_PATTERN.fullmatch(token) is None:
            raise HelperError()
    return op, profile, origin, token


def scope_attributes(profile, origin):
    """Return the exact attributes that scope one credential."""
    return {"namespace": NAMESPACE, "profile": profile, "origin": origin}


def in_scope(item, profile, origin):
    """Verify both the schema and the three attributes of this application's scope."""
    attributes = item.get_attributes() or {}
    expected = scope_attributes(profile, origin)
    expected["xdg:schema"] = SCHEMA_NAME
    return all(attributes.get(key) == value for key, value in expected.items())


def build_schema(bindings):
    """Build the fixed schema of this application, which has three string attributes."""
    Secret = bindings.Secret
    return Secret.Schema.new(
        SCHEMA_NAME,
        Secret.SchemaFlags.NONE,
        {
            "namespace": Secret.SchemaAttributeType.STRING,
            "profile": Secret.SchemaAttributeType.STRING,
            "origin": Secret.SchemaAttributeType.STRING,
        },
    )


def require_running_service(Gio):
    """Return the unique bus owner without starting the secret service.

    The proxy carries both DO_NOT_AUTO_START and DO_NOT_AUTO_START_AT_CONSTRUCTION,
    so neither its construction nor a method call starts a service. A name that
    has no owner is reported as unavailable instead of being started.
    """
    flags = (
        Gio.DBusProxyFlags.DO_NOT_AUTO_START
        | Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION
        | Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES
    )
    try:
        proxy = Gio.DBusProxy.new_for_bus_sync(
            Gio.BusType.SESSION,
            flags,
            None,
            SERVICE_NAME,
            SERVICE_PATH,
            SERVICE_INTERFACE,
            None,
        )
        owner = proxy.get_name_owner()
    except Exception:
        raise UnavailableError()
    if not owner:
        raise UnavailableError()
    return owner


def open_service(bindings):
    """Open the already running secret service over the session bus."""
    owner = require_running_service(bindings.Gio)
    Secret = bindings.Secret
    try:
        # A provider can exit after the owner check. A unique D-Bus name
        # cannot be auto-started or resolved to a replacement provider.
        service = Secret.Service.open_sync(
            Secret.Service.__gtype__, owner, Secret.ServiceFlags.OPEN_SESSION, None
        )
    except Exception:
        raise UnavailableError()
    if service is None:
        raise UnavailableError()
    return service


def search_items(bindings, service, schema, attributes):
    """Return every exact match, locked ones included. A search never unlocks."""
    try:
        items = service.search_sync(schema, attributes, bindings.Secret.SearchFlags.ALL, None)
    except Exception:
        raise UnavailableError()
    return list(items or [])


def default_collection(bindings, service):
    """Return the default collection, which has to exist already."""
    Secret = bindings.Secret
    try:
        collection = Secret.Collection.for_alias_sync(
            service,
            Secret.COLLECTION_DEFAULT,
            Secret.CollectionFlags.NONE,
            None,
        )
    except Exception:
        raise UnavailableError()
    if collection is None:
        raise UnavailableError()
    return collection


def select_single(items, profile, origin):
    """Return the one exact match. Duplicates, locked and out-of-scope matches are refused."""
    if len(items) > 1:
        raise AmbiguousError()
    item = items[0]
    if item.get_locked():
        raise LockedError()
    if not in_scope(item, profile, origin):
        raise HelperError()
    return item


def label_for(profile):
    """Return the visible label of a record. The profile name is not secret."""
    return "PTO Calendar agent credential " + profile


def build_value(bindings, token):
    """Return the secret value of a token."""
    return bindings.Secret.Value.new(token, len(token.encode("utf-8")), "text/plain")


def op_get(bindings, profile, origin):
    """Read one credential without unlocking and without prompting."""
    service = open_service(bindings)
    schema = build_schema(bindings)
    items = search_items(bindings, service, schema, scope_attributes(profile, origin))
    if not items:
        return {"status": "missing"}
    item = select_single(items, profile, origin)
    try:
        loaded = bindings.Secret.Item.load_secrets_sync([item], None)
    except Exception:
        raise UnavailableError()
    if not loaded:
        if item.get_locked():
            raise LockedError()
        raise HelperError()
    value = item.get_secret()
    text = value.get_text() if value is not None else None
    if not isinstance(text, str) or TOKEN_PATTERN.fullmatch(text) is None:
        raise HelperError()
    return {"status": "ok", "token": text}


def op_set(bindings, profile, origin, token):
    """Store one credential in the already initialized, unlocked default collection."""
    service = open_service(bindings)
    schema = build_schema(bindings)
    attributes = scope_attributes(profile, origin)
    collection = default_collection(bindings, service)
    if collection.get_locked():
        raise LockedError()
    items = search_items(bindings, service, schema, attributes)
    value = build_value(bindings, token)
    if items:
        # Only the one exact, unlocked match is updated. A broad replacement is never used.
        item = select_single(items, profile, origin)
        try:
            updated = item.set_secret_sync(value, None)
        except Exception:
            raise HelperError()
        if not updated or not in_scope(item, profile, origin):
            raise HelperError()
        return {"status": "ok"}
    try:
        created = bindings.Secret.Item.create_sync(
            collection,
            schema,
            attributes,
            label_for(profile),
            value,
            bindings.Secret.ItemCreateFlags.NONE,
            None,
        )
    except Exception:
        raise HelperError()
    if created is None or not in_scope(created, profile, origin):
        raise HelperError()
    return {"status": "ok"}


def op_remove(bindings, profile, origin):
    """Remove the one credential of this scope from the initialized, unlocked default collection."""
    service = open_service(bindings)
    schema = build_schema(bindings)
    collection = default_collection(bindings, service)
    if collection.get_locked():
        raise LockedError()
    items = search_items(bindings, service, schema, scope_attributes(profile, origin))
    if not items:
        return {"status": "absent"}
    item = select_single(items, profile, origin)
    try:
        deleted = item.delete_sync(None)
    except Exception:
        raise HelperError()
    if not deleted:
        raise HelperError()
    return {"status": "removed"}


def respond():
    """Return the one answer of this request. It never raises."""
    try:
        request = read_request()
        op, profile, origin, token = checked_request(request)
    except HelperError:
        return failure(CODE_FAILED)
    try:
        bindings = load_bindings()
    except UnsupportedError:
        return failure(CODE_UNSUPPORTED)
    try:
        if op == "get":
            return op_get(bindings, profile, origin)
        if op == "set":
            return op_set(bindings, profile, origin, token)
        return op_remove(bindings, profile, origin)
    except HelperError as error:
        return failure(error.code)
    except Exception:
        return failure(CODE_FAILED)


def main():
    """Answer one request with one JSON object on the real standard output."""
    kept = os.dup(1)
    os.dup2(2, 1)
    try:
        payload = respond()
        sys.stdout.flush()
    finally:
        os.dup2(kept, 1)
        os.close(kept)
    emit(payload)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException:
        # A traceback would carry host data, so it never reaches stdout.
        try:
            emit(failure(CODE_FAILED))
        except BaseException:
            pass
        sys.exit(1)
