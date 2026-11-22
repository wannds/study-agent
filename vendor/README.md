# Bundled course2md engine

`course2md-engine/` contains the engine/CLI source from https://github.com/mizorewww/course2md at commit `1ef09ae1c60ffee642b2ca3cd1778a9275589715` (MIT). Its original license is preserved in `course2md-engine/LICENSE`.

Study Agent builds this CLI as its own bundled video worker and uses its local account/source crate. No separate course2md checkout or installation is required. The upstream GPUI desktop UI is not included.

Local changes: workspace membership excludes the upstream desktop; the Windows Bilibili TLS client uses system trust roots with certificate validation enabled. Remaining source files retain upstream provenance.

`c2m-source/` is the legacy standalone account copy retained locally during migration; it is not a build dependency or part of the published source.
