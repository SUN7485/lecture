# Local commercial-engine tournament

This adapter is deliberately outside editor logic. It evaluates engines in the
fixed order Aspose, Apryse, Foxit only after two consecutive convergence turns
each gain less than 0.3 points while damage remains above 250.

Check the gate without converting anything:

```
node experiments/vendors/run.js --status --history experiments/benchmark/baseline.json,.work/benchmark-current-full.json,.work/benchmark-editable-page-scores.json
```

Current result: **deferred**. The measured turns are +1.24 and +0.17 points, so
only the second qualifies. No temporary-license clock has been started.

The local .NET 10 Aspose runner builds with:

```
dotnet build experiments/vendors/aspose-runner/AsposeRunner.csproj -c Release
```

An unlicensed `--evaluation` run is restricted to at most four input pages.
Anything larger requires an explicit local license path; license files are
ignored by Git. Apryse and Foxit are invoked only through configured local
executables. All engines face the same open-without-repair, +3 visual points,
95% native text, Arabic-loss, disguised-raster, damage-reduction and runtime
gates.

Official references: [Aspose PDF to PowerPoint](https://docs.aspose.com/pdf/net/convert-pdf-to-powerpoint/),
[Aspose licensing](https://docs.aspose.com/pdf/net/licensing/),
[Apryse Office conversion](https://docs.apryse.com/core/guides/features/office/convert-to-office?language=java),
[Foxit PDF Conversion SDK](https://developers.foxit.com/products/pdf-conversion-sdk/).
