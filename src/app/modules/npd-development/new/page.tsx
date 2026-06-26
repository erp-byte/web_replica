"use client";

// "New NPD sample" — a preset of the NpdSampleForm (NPD type). The form is a
// minimal request: the requester names the target article; the NPD team authors
// the recipe later on the requisition detail page.
import { NpdSampleForm } from "../_npd-sample-form";

export default function NewNpdSamplePage() {
  return <NpdSampleForm defaultType="NPD" heading="New NPD sample" />;
}
