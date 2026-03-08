Build an IPFS HLS Video Player using helia. It should be able to stream videos using true peer-to-peer connections, not just streaming data via an IPFS relay.

https://charade.fu.io/ used to have a working example of what we're trying to build, however it no longer works. Namely:
 - ipfs-js is now defunct as it has been replaced by helia. So we'll also need to use helia
 - hlsjs-ipfs-loader is also abandoned and does not work any more.


We should create a npm monorepo.
 - One workspace should a new hls loader that uses helia components.
 - Another workspace that is an example of using that loader.
 - A tests directory using playwright to ensure that the video does infact play.


All code should be written in well typed typescript.

The ipfs path /ipfs/QmbdmJ2JRvEFhWWzHKrAcjjBdkcs46F2N7ggZnrdKKAu4s/manifest.m3u8 can be used as the test path.


