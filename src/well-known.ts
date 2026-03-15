import { Router } from 'express';
import { config } from './config';

export const wellKnownRouter = Router();

wellKnownRouter.get('/.well-known/did.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: config.feedgenServiceDid,
    service: [
      {
        id: '#bsky_fg',
        type: 'BskyFeedGenerator',
        serviceEndpoint: `https://${config.feedgenHostname}`,
      },
    ],
  });
});
