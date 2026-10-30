import numpy as np
from workers import Response, WorkerEntrypoint

class Default(WorkerEntrypoint):
    async def fetch(self, request):
        return Response(f"{self.env.MESSAGE}:{np.arange(3).sum()}")
