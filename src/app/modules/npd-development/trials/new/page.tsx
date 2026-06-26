"use client";

// "New customer trial" — a preset of the NpdSampleForm (TRIAL type). Same
// minimal request form as NPD; only the type differs (customer name shown).
import { NpdSampleForm } from "../../_npd-sample-form";

export default function NewTrialPage() {
  return <NpdSampleForm defaultType="TRIAL" heading="New customer trial" />;
}
