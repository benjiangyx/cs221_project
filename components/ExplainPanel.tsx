"use client";

import { SpreadResult } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";

interface ExplainPanelProps {
  spreadExplain: SpreadResult["explain"] | null;
}

/** Where the spread envelope comes from: learned rate, coverage, inputs used and missing. */
export default function ExplainPanel({ spreadExplain }: ExplainPanelProps) {
  if (!spreadExplain) return null;

  // The first note restates the rate, already shown as the headline number.
  const notes = spreadExplain.notes.filter((n) => !/^Learned (growth|head) rate/.test(n));
  const isEllipse = spreadExplain.shape === "wind_ellipse";

  return (
    <Card className="ic-card text-white">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
            Spread Forecast
          </h3>
          <span className="text-[10px] text-zinc-500">
            {spreadExplain.model} · {isEllipse ? "wind ellipse" : "circle"}
          </span>
        </div>

        <div className="flex items-baseline gap-2">
          <span className="text-xl font-bold text-orange-400 tabular-nums">
            {spreadExplain.rateKmH.toFixed(2)}
          </span>
          <span className="text-xs text-zinc-400">
            km/h learned {isEllipse ? "head rate (downwind)" : "growth rate"}
          </span>
        </div>

        <ul className="space-y-1">
          {notes.map((note, i) => (
            <li
              key={i}
              className={`text-xs flex items-start gap-1.5 ${
                note.startsWith("Not available") ? "text-amber-400" : "text-zinc-400"
              }`}
            >
              <span className="shrink-0">•</span>
              <span>{note}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
