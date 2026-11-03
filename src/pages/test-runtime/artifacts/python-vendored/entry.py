import hashlib
import json
from pathlib import Path

import six
from workers import Response, WorkerEntrypoint


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return Response(json.dumps({
            "message": str(self.env.MESSAGE),
            "dependency": "six",
            "version": six.__version__,
            "value": sum(value for _, value in six.iteritems({"answer": 3})),
            "moduleSha256": hashlib.sha256(Path(six.__file__).read_bytes()).hexdigest(),
            "modulePath": six.__file__,
        }))
