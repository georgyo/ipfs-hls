Let's make another example here that uses svelte as a frame work for using these.

It should
 - Have an input feild to load IPFS paths
 - Have a client side history of previously loaded paths
 - The history should have these two items as default as presets
   - Charade /ipfs/QmbdmJ2JRvEFhWWzHKrAcjjBdkcs46F2N7ggZnrdKKAu4s/manifest.m3u8
   - Big Buck Bunny /ipfs/QmfL9GReWbQbwgrQG4j3aFJaJb6UEyeDfuy8GRQcH5F5NS/manifest.m3u8
 - Click on a history item should load that path and start playing
 - If there are multiple HLS streams of different quality, there should be a quality selector
 - The default quality should be auto selecting
