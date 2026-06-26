"use client";

// "Convert article" — a preset of the NpdSampleForm (NPD type). The recipe
// (base BOM and ingredients) is authored by the NPD team on the requisition
// detail page; this entry just raises the request.
import { NpdSampleForm } from "../../_npd-sample-form";

export default function ConvertArticlePage() {
  return <NpdSampleForm defaultType="NPD" heading="Convert article" />;
}
