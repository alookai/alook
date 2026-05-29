import { NextResponse } from "next/server";
import { getTemplateById } from "@/lib/templates";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const template = getTemplateById(id);

  if (!template) {
    return NextResponse.json(
      { error: "Template not found" },
      { status: 404 },
    );
  }

  const response = {
    name: template.name,
    scenario: template.baseScenario,
    members: template.members.map((m) => ({
      role: m.role,
      description: m.description,
      instructions: m.instructions,
      ...(m.relationship ? { relationship: m.relationship } : {}),
    })),
  };

  return NextResponse.json(response);
}
