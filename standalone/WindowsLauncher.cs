using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

internal static class Program
{
    private const string Version = "0.6.4";

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
        var b = new StringBuilder();
        b.Append('"');
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { b.Append('\\', slashes * 2 + 1); b.Append('"'); slashes = 0; continue; }
            if (slashes > 0) { b.Append('\\', slashes); slashes = 0; }
            b.Append(c);
        }
        if (slashes > 0) b.Append('\\', slashes * 2);
        b.Append('"');
        return b.ToString();
    }

    private static string EnsurePayload()
    {
        string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FastHands", Version, "win-x64");
        string marker = Path.Combine(root, ".ready");
        string node = Path.Combine(root, "runtime", "node.exe");
        string app = Path.Combine(root, "app", "node_modules", "fast-hands-mcp", "bin", "fast-hands.mjs");
        if (File.Exists(marker) && File.Exists(node) && File.Exists(app)) return root;

        if (Directory.Exists(root)) Directory.Delete(root, true);
        Directory.CreateDirectory(root);
        string zipPath = Path.Combine(root, "payload.zip");
        using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
        {
            if (input == null) throw new InvalidOperationException("Embedded Fast Hands payload is missing.");
            using (var output = File.Create(zipPath)) input.CopyTo(output);
        }
        ZipFile.ExtractToDirectory(zipPath, root);
        File.Delete(zipPath);
        File.WriteAllText(marker, Version);
        return root;
    }

    public static int Main(string[] args)
    {
        try
        {
            string root = EnsurePayload();
            string node = Path.Combine(root, "runtime", "node.exe");
            string script = Path.Combine(root, "app", "node_modules", "fast-hands-mcp", "bin", "fast-hands.mjs");
            var all = new StringBuilder();
            all.Append(Quote(script));
            foreach (string arg in args) { all.Append(' '); all.Append(Quote(arg)); }
            var psi = new ProcessStartInfo(node, all.ToString());
            psi.UseShellExecute = false;
            psi.WorkingDirectory = root;
            var child = Process.Start(psi);
            child.WaitForExit();
            return child.ExitCode;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("Fast Hands launcher error: " + ex.Message);
            return 1;
        }
    }
}
