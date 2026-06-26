# Roadmap

- **v2: live-streamed body.** Yield each `BodyPart` as soon as its headers are parsed, with `body` as a back-pressured live stream that receives bytes as they arrive. Enables true streaming of arbitrarily-sized parts. Imposes a strict "consume each part before the next" contract on callers.
