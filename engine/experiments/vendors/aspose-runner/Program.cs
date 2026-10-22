using Aspose.Pdf;

if (args.Length < 2)
{
    Console.Error.WriteLine("usage: AsposeRunner <input.pdf> <output.pptx> [--evaluation-ok]");
    return 2;
}

var input = Path.GetFullPath(args[0]);
var output = Path.GetFullPath(args[1]);
var evaluationAllowed = args.Contains("--evaluation-ok");
var licensePath = Environment.GetEnvironmentVariable("ASPOSE_PDF_LICENSE");
if (!string.IsNullOrWhiteSpace(licensePath))
{
    if (!File.Exists(licensePath)) throw new FileNotFoundException("ASPOSE_PDF_LICENSE does not exist", licensePath);
    var license = new License();
    license.SetLicense(licensePath);
}

using var document = new Document(input);
if (string.IsNullOrWhiteSpace(licensePath) && (!evaluationAllowed || document.Pages.Count > 4))
{
    throw new InvalidOperationException(
        $"Unlicensed Aspose evaluation is allowed only for an explicit <=4-page smoke test; input has {document.Pages.Count} pages.");
}

Directory.CreateDirectory(Path.GetDirectoryName(output)!);
var options = new PptxSaveOptions { SlidesAsImages = false };
document.Save(output, options);
return 0;

