import * as _AWS from '@aws-sdk/client-ecr';
import { getDigest, getPkgReleases } from '..';
import * as httpMock from '../../../test/http-mock';
import { mocked, partial } from '../../../test/util';
import { EXTERNAL_HOST_ERROR } from '../../constants/error-messages';
import * as _hostRules from '../../util/host-rules';
import { id } from './common';
import { MediaType } from './types';

const hostRules = mocked(_hostRules);

jest.mock('@aws-sdk/client-ecr');
jest.mock('../../util/host-rules');

type ECR = _AWS.ECR;
type GetAuthorizationTokenCommandOutput =
  _AWS.GetAuthorizationTokenCommandOutput;
const AWS = mocked(_AWS);

const baseUrl = 'https://index.docker.io/v2';
const authUrl = 'https://auth.docker.io';
const amazonUrl = 'https://123456789.dkr.ecr.us-east-1.amazonaws.com/v2';

function mockEcrAuthResolve(
  res: Partial<GetAuthorizationTokenCommandOutput> = {}
) {
  AWS.ECR.mockImplementationOnce(() =>
    partial<ECR>({
      getAuthorizationToken: () =>
        Promise.resolve<GetAuthorizationTokenCommandOutput>(
          partial<GetAuthorizationTokenCommandOutput>(res)
        ),
    })
  );
}

function mockEcrAuthReject(msg: string) {
  AWS.ECR.mockImplementationOnce(() =>
    partial<ECR>({
      getAuthorizationToken: jest.fn().mockRejectedValue(new Error(msg)),
    })
  );
}

describe('datasource/docker/index', () => {
  beforeEach(() => {
    hostRules.find.mockReturnValue({
      username: 'some-username',
      password: 'some-password',
    });
    hostRules.hosts.mockReturnValue([]);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('getDigest', () => {
    it('returns null if no token', async () => {
      httpMock
        .scope(baseUrl)
        .get('/', undefined, { badheaders: ['authorization'] })
        .reply(200, '', {})
        .head('/library/some-dep/manifests/some-new-value', undefined, {
          badheaders: ['authorization'],
        })
        .reply(401);
      const res = await getDigest(
        { datasource: 'docker', depName: 'some-dep' },
        'some-new-value'
      );
      expect(res).toBeNull();
    });

    it('returns null if errored', async () => {
      httpMock
        .scope(baseUrl)
        .get('/', undefined, { badheaders: ['authorization'] })
        .reply(200, { token: 'abc' })
        .head('/library/some-dep/manifests/some-new-value', undefined, {
          reqheaders: { authorization: 'Bearer abc' },
        })
        .replyWithError('error');
      const res = await getDigest(
        { datasource: 'docker', depName: 'some-dep' },
        'some-new-value'
      );
      expect(res).toBeNull();
    });

    it('returns null if empty header', async () => {
      httpMock
        .scope(baseUrl)
        .get('/', undefined, { badheaders: ['authorization'] })
        .reply(200, { token: 'some-token' })
        .head('/library/some-dep/manifests/some-new-value')
        .reply(200, undefined, { 'docker-content-digest': '' });
      const res = await getDigest(
        { datasource: 'docker', depName: 'some-dep' },
        'some-new-value'
      );
      expect(res).toBeNull();
    });

    it('returns digest', async () => {
      httpMock
        .scope(baseUrl)
        .get('/')
        .reply(401, '', {
          'www-authenticate':
            'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:samalba/my-app:pull  "',
        })
        .head('/library/some-dep/manifests/latest')
        .reply(200, {}, { 'docker-content-digest': 'some-digest' });
      httpMock
        .scope(authUrl)
        .get(
          '/token?service=registry.docker.io&scope=repository:library/some-dep:pull'
        )
        .reply(200, { token: 'some-token' });

      hostRules.find.mockReturnValue({});
      const res = await getDigest({
        datasource: 'docker',
        depName: 'some-dep',
      });
      expect(res).toBe('some-digest');
    });

    it('falls back to body for digest', async () => {
      httpMock
        .scope(baseUrl)
        .get('/')
        .twice()
        .reply(401, '', {
          'www-authenticate':
            'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:samalba/my-app:pull  "',
        })
        .head('/library/some-dep/manifests/some-new-value')
        .reply(200, undefined, {})
        .get('/library/some-dep/manifests/some-new-value')
        .reply(
          200,
          `{
          "signatures": [
             {
                "header": {
                   "jwk": {
                      "crv": "P-256",
                      "kid": "DB2X:GSG2:72H3:AE3R:KCMI:Y77E:W7TF:ERHK:V5HR:JJ2Y:YMS6:HFGJ",
                      "kty": "EC",
                      "x": "jyr9-xZBorSC9fhqNsmfU_Ud31wbaZ-bVGz0HmySvbQ",
                      "y": "vkE6qZCCvYRWjSUwgAOvibQx_s8FipYkAiHS0VnAFNs"
                   },
                   "alg": "ES256"
                },
                "signature": "yUXzEiPzg_SlQlqGW43H6oMgYuz30zSkj2qauQc_kbyI9RQHucYAKs_lBSFaQdDrtgW-1iDZSP9eExKP8ANSyA",
                "protected": "eyJmb3JtYXRMZW5ndGgiOjgzMDAsImZvcm1hdFRhaWwiOiJDbjAiLCJ0aW1lIjoiMjAxOC0wMi0wNVQxNDoyMDoxOVoifQ"
             }
          ]
       }`,
          {
            'content-type': 'text/plain',
          }
        );
      httpMock
        .scope(authUrl)
        .get(
          '/token?service=registry.docker.io&scope=repository:library/some-dep:pull'
        )
        .twice()
        .reply(200, { token: 'some-token' });
      const res = await getDigest(
        { datasource: 'docker', depName: 'some-dep' },
        'some-new-value'
      );
      expect(res).toBe(
        'sha256:b3d6068234f3a18ebeedd2dab81e67b6a192e81192a099df4112ecfc7c3be84f'
      );
    });

    it('supports docker insecure registry', async () => {
      httpMock
        .scope(baseUrl.replace('https', 'http'))
        .get('/', undefined, { badheaders: ['authorization'] })
        .reply(200)
        .head('/library/some-dep/manifests/latest')
        .reply(200, '', { 'docker-content-digest': 'some-digest' });
      hostRules.find.mockReturnValueOnce({ insecureRegistry: true });
      const res = await getDigest({
        datasource: 'docker',
        depName: 'some-dep',
      });
      expect(res).toBe('some-digest');
    });

    it('supports basic authentication', async () => {
      httpMock
        .scope(baseUrl)
        .get('/', undefined, { badheaders: ['authorization'] })
        .reply(401, '', {
          'www-authenticate': 'Basic realm="My Private Docker Registry Server"',
        })

        .head('/library/some-dep/manifests/some-tag')
        .matchHeader(
          'authorization',
          'Basic c29tZS11c2VybmFtZTpzb21lLXBhc3N3b3Jk'
        )
        .reply(200, '', { 'docker-content-digest': 'some-digest' });
      const res = await getDigest(
        { datasource: 'docker', depName: 'some-dep' },
        'some-tag'
      );
      expect(res).toBe('some-digest');
    });

    it('returns null for 403 with basic authentication', async () => {
      httpMock
        .scope(baseUrl)
        .get('/', undefined, { badheaders: ['authorization'] })
        .reply(401, '', {
          'www-authenticate': 'Basic realm="My Private Docker Registry Server"',
        })
        .head('/library/some-dep/manifests/some-tag')
        .reply(403);
      const res = await getDigest(
        { datasource: 'docker', depName: 'some-dep' },
        'some-tag'
      );
      expect(res).toBeNull();
    });

    it('passes credentials to ECR client', async () => {
      httpMock
        .scope(amazonUrl)
        .get('/')
        .reply(401, '', {
          'www-authenticate': 'Basic realm="My Private Docker Registry Server"',
        })
        .head('/node/manifests/some-tag')
        .matchHeader('authorization', 'Basic test_token')
        .reply(200, '', { 'docker-content-digest': 'some-digest' });

      mockEcrAuthResolve({
        authorizationData: [{ authorizationToken: 'test_token' }],
      });

      await getDigest(
        {
          datasource: 'docker',
          depName: '123456789.dkr.ecr.us-east-1.amazonaws.com/node',
        },
        'some-tag'
      );

      expect(AWS.ECR).toHaveBeenCalledWith({
        credentials: {
          accessKeyId: 'some-username',
          secretAccessKey: 'some-password',
        },
        region: 'us-east-1',
      });
    });

    it('passes session token to ECR client', async () => {
      httpMock
        .scope(amazonUrl)
        .get('/')
        .reply(401, '', {
          'www-authenticate': 'Basic realm="My Private Docker Registry Server"',
        })
        .head('/node/manifests/some-tag')
        .matchHeader('authorization', 'Basic test_token')
        .reply(200, '', { 'docker-content-digest': 'some-digest' });

      hostRules.find.mockReturnValue({
        username: 'some-username',
        password: 'some-password',
        token: 'some-session-token',
      });

      mockEcrAuthResolve({
        authorizationData: [{ authorizationToken: 'test_token' }],
      });

      await getDigest(
        {
          datasource: 'docker',
          depName: '123456789.dkr.ecr.us-east-1.amazonaws.com/node',
        },
        'some-tag'
      );

      expect(AWS.ECR).toHaveBeenCalledWith({
        credentials: {
          accessKeyId: 'some-username',
          secretAccessKey: 'some-password',
          sessionToken: 'some-session-token',
        },
        region: 'us-east-1',
      });
    });

    it('supports ECR authentication', async () => {
      httpMock
        .scope(amazonUrl)
        .get('/')
        .reply(401, '', {
          'www-authenticate': 'Basic realm="My Private Docker Registry Server"',
        })
        .head('/node/manifests/some-tag')
        .matchHeader('authorization', 'Basic test')
        .reply(200, '', { 'docker-content-digest': 'some-digest' });

      mockEcrAuthResolve({
        authorizationData: [{ authorizationToken: 'test' }],
      });

      const res = await getDigest(
        {
          datasource: 'docker',
          depName: '123456789.dkr.ecr.us-east-1.amazonaws.com/node',
        },
        'some-tag'
      );

      expect(res).toBe('some-digest');
    });

    it('continues without token if ECR authentication could not be extracted', async () => {
      httpMock.scope(amazonUrl).get('/').reply(401, '', {
        'www-authenticate': 'Basic realm="My Private Docker Registry Server"',
      });
      mockEcrAuthResolve();

      const res = await getDigest(
        {
          datasource: 'docker',
          depName: '123456789.dkr.ecr.us-east-1.amazonaws.com/node',
        },
        'some-tag'
      );
      expect(res).toBeNull();
    });

    it('continues without token if ECR authentication fails', async () => {
      hostRules.find.mockReturnValue({});
      httpMock.scope(amazonUrl).get('/').reply(401, '', {
        'www-authenticate': 'Basic realm="My Private Docker Registry Server"',
      });
      mockEcrAuthReject('some error');
      const res = await getDigest(
        {
          datasource: 'docker',
          depName: '123456789.dkr.ecr.us-east-1.amazonaws.com/node',
        },
        'some-tag'
      );
      expect(res).toBeNull();
    });

    it('continues without token, when no header is present', async () => {
      httpMock
        .scope(baseUrl)
        .get('/')
        .reply(200, '', {
          'content-type': 'text/plain',
        })
        .head('/library/some-dep/manifests/some-new-value')
        .reply(200, {}, { 'docker-content-digest': 'some-digest' });
      const res = await getDigest(
        { datasource: 'docker', depName: 'some-dep' },
        'some-new-value'
      );
      expect(res).toBe('some-digest');
    });

    it('supports scoped names', async () => {
      httpMock
        .scope(baseUrl)
        .get('/')
        .reply(401, '', {
          'www-authenticate':
            'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:samalba/my-app:pull  "',
        })
        .head('/library/some-other-dep/manifests/8.0.0-alpine')
        .reply(200, {}, { 'docker-content-digest': 'some-digest' });
      httpMock
        .scope(authUrl)
        .get(
          '/token?service=registry.docker.io&scope=repository:library/some-other-dep:pull'
        )
        .reply(200, { access_token: 'test' });
      const res = await getDigest(
        { datasource: 'docker', depName: 'some-other-dep' },
        '8.0.0-alpine'
      );
      expect(res).toBe('some-digest');
    });

    it('should throw error for 429', async () => {
      httpMock.scope(baseUrl).get('/').replyWithError({ statusCode: 429 });
      await expect(
        getDigest({ datasource: 'docker', depName: 'some-dep' }, 'latest')
      ).rejects.toThrow(EXTERNAL_HOST_ERROR);
    });

    it('should throw error for 5xx', async () => {
      httpMock.scope(baseUrl).get('/').replyWithError({ statusCode: 504 });
      await expect(
        getDigest({ datasource: 'docker', depName: 'some-dep' }, 'latest')
      ).rejects.toThrow(EXTERNAL_HOST_ERROR);
    });
  });

  describe('getReleases', () => {
    it('returns null if no token', async () => {
      httpMock
        .scope(baseUrl)
        .get('/')
        .reply(200, '', {})
        .get('/library/node/tags/list?n=10000')
        .reply(403);
      const res = await getPkgReleases({
        datasource: id,
        depName: 'node',
        registryUrls: ['https://docker.io'],
      });
      expect(res).toBeNull();
    });

    it('uses custom registry with registryUrls', async () => {
      const tags = ['1.0.0'];
      httpMock
        .scope('https://registry.company.com/v2')
        .get('/')
        .reply(200, '', {})
        .get('/node/tags/list?n=10000')
        .reply(
          200,
          { tags },
          {
            link: '<https://api.github.com/user/9287/repos?page=3&per_page=100>; rel="next", ',
          }
        )
        .get('/')
        .reply(200)
        .get('/node/manifests/latest')
        .reply(200);
      httpMock
        .scope('https://api.github.com')
        .get('/user/9287/repos?page=3&per_page=100')
        .reply(200, { tags: ['latest'] }, {});
      const config = {
        datasource: id,
        depName: 'node',
        registryUrls: ['https://registry.company.com'],
      };
      const res = await getPkgReleases(config);
      expect(res.releases).toHaveLength(1);
    });

    it('uses custom registry in depName', async () => {
      const tags = ['1.0.0'];
      httpMock
        .scope('https://registry.company.com/v2')
        .get('/')
        .reply(200, '', {})
        .get('/node/tags/list?n=10000')
        .reply(200, { tags }, {})
        .get('/')
        .reply(200, '', {})
        .get('/node/manifests/1.0.0')
        .reply(200, '', {});
      const res = await getPkgReleases({
        datasource: id,
        depName: 'registry.company.com/node',
      });
      expect(res.releases).toHaveLength(1);
    });

    it('uses quay api', async () => {
      const tags = [{ name: '5.0.12' }];
      httpMock
        .scope('https://quay.io')
        .get(
          '/api/v1/repository/bitnami/redis/tag/?limit=100&page=1&onlyActiveTags=true'
        )
        .reply(200, { tags, has_additional: true })
        .get(
          '/api/v1/repository/bitnami/redis/tag/?limit=100&page=2&onlyActiveTags=true'
        )
        .reply(200, { tags: [], has_additional: false })
        .get('/v2/')
        .reply(200, '', {})
        .get('/v2/bitnami/redis/manifests/5.0.12')
        .reply(200, '', {});
      const config = {
        datasource: id,
        depName: 'bitnami/redis',
        registryUrls: ['https://quay.io'],
      };
      const res = await getPkgReleases(config);
      expect(res.releases).toHaveLength(1);
    });

    it('uses quay api and test error', async () => {
      httpMock
        .scope('https://quay.io')
        .get(
          '/api/v1/repository/bitnami/redis/tag/?limit=100&page=1&onlyActiveTags=true'
        )
        .reply(500);
      const config = {
        datasource: id,
        depName: 'bitnami/redis',
        registryUrls: ['https://quay.io'],
      };
      await expect(getPkgReleases(config)).rejects.toThrow(
        'external-host-error'
      );
    });

    it('uses lower tag limit for ECR deps', async () => {
      httpMock
        .scope(amazonUrl)
        .get('/')
        .reply(200, '', {})
        // The  tag limit parameter `n` needs to be limited to 1000 for ECR
        // See https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_DescribeRepositories.html#ECR-DescribeRepositories-request-maxResults
        .get('/node/tags/list?n=1000')
        .reply(200, { tags: ['some'] }, {})
        .get('/')
        .reply(200, '', {})
        .get('/node/manifests/some')
        .reply(200);
      expect(
        await getPkgReleases({
          datasource: id,
          depName: '123456789.dkr.ecr.us-east-1.amazonaws.com/node',
        })
      ).toEqual({
        registryUrl: 'https://123456789.dkr.ecr.us-east-1.amazonaws.com',
        releases: [],
      });
    });

    it('adds library/ prefix for Docker Hub (implicit)', async () => {
      const tags = ['1.0.0'];
      httpMock
        .scope(baseUrl)
        .get('/')
        .reply(401, '', {
          'www-authenticate':
            'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/node:pull  "',
        })
        .get('/library/node/tags/list?n=10000')
        .reply(200, { tags }, {})
        .get('/')
        .reply(200)
        .get('/library/node/manifests/1.0.0')
        .reply(200);
      httpMock
        .scope(authUrl)
        .get(
          '/token?service=registry.docker.io&scope=repository:library/node:pull'
        )
        .reply(200, { token: 'test' });
      const res = await getPkgReleases({
        datasource: id,
        depName: 'node',
      });
      expect(res.releases).toHaveLength(1);
    });

    it('adds library/ prefix for Docker Hub (explicit)', async () => {
      const tags = ['1.0.0'];
      httpMock
        .scope(baseUrl)
        .get('/')
        .reply(401, '', {
          'www-authenticate':
            'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/node:pull  "',
        })
        .get('/library/node/tags/list?n=10000')
        .reply(200, { tags }, {})
        .get('/')
        .reply(200)
        .get('/library/node/manifests/1.0.0')
        .reply(200);
      httpMock
        .scope(authUrl)
        .get(
          '/token?service=registry.docker.io&scope=repository:library/node:pull'
        )
        .reply(200, { token: 'test' });
      const res = await getPkgReleases({
        datasource: id,
        depName: 'docker.io/node',
      });
      expect(res.releases).toHaveLength(1);
    });

    it('adds no library/ prefix for other registries', async () => {
      const tags = ['1.0.0'];
      httpMock
        .scope('https://k8s.gcr.io/v2/')
        .get('/')
        .reply(401, '', {
          'www-authenticate':
            'Bearer realm="https://k8s.gcr.io/v2/token",service="k8s.gcr.io"',
        })
        .get(
          '/token?service=k8s.gcr.io&scope=repository:kubernetes-dashboard-amd64:pull'
        )
        .reply(200, { token: 'some-token ' })
        .get('/kubernetes-dashboard-amd64/tags/list?n=10000')
        .reply(200, { tags }, {})
        .get('/')
        .reply(200)
        .get('/kubernetes-dashboard-amd64/manifests/1.0.0')
        .reply(200);
      const res = await getPkgReleases({
        datasource: id,
        depName: 'k8s.gcr.io/kubernetes-dashboard-amd64',
      });
      expect(res.releases).toHaveLength(1);
    });

    it('returns null on error', async () => {
      httpMock
        .scope(baseUrl)
        .get('/')
        .reply(200, null)
        .get('/my/node/tags/list?n=10000')
        .replyWithError('error');
      const res = await getPkgReleases({
        datasource: id,
        depName: 'my/node',
      });
      expect(res).toBeNull();
    });

    it('strips trailing slash from registry', async () => {
      httpMock
        .scope(baseUrl)
        .get('/')
        .reply(401, '', {
          'www-authenticate':
            'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:my/node:pull  "',
        })
        .get('/my/node/tags/list?n=10000')
        .reply(200, { tags: ['1.0.0'] }, {})
        .get('/')
        .reply(200)
        .get('/my/node/manifests/1.0.0')
        .reply(200);
      httpMock
        .scope(authUrl)
        .get('/token?service=registry.docker.io&scope=repository:my/node:pull')
        .reply(200, { token: 'some-token ' });
      const res = await getPkgReleases({
        datasource: id,
        depName: 'my/node',
        registryUrls: ['https://index.docker.io/'],
      });
      expect(res?.releases).toHaveLength(1);
    });

    it('returns null if no auth', async () => {
      hostRules.find.mockReturnValue({});
      httpMock.scope(baseUrl).get('/').reply(401, undefined, {
        'www-authenticate': 'Basic realm="My Private Docker Registry Server"',
      });
      const res = await getPkgReleases({
        datasource: id,
        depName: 'node',
      });
      expect(res).toBeNull();
    });

    it('supports labels', async () => {
      httpMock
        .scope('https://registry.company.com/v2')
        .get('/')
        .times(3)
        .reply(200)
        .get('/node/tags/list?n=10000')
        .reply(200, {
          tags: [
            '2.0.0',
            '2-alpine',
            '1-alpine',
            '1.0.0',
            '1.2.3',
            '1.2.3-alpine',
            'abc',
          ],
        })
        .get('/node/manifests/2-alpine')
        .reply(200, {
          schemaVersion: 2,
          mediaType: MediaType.manifestV2,
          config: { digest: 'some-config-digest' },
        })
        .get('/node/blobs/some-config-digest')
        .reply(200, {
          config: {
            Labels: {
              'org.opencontainers.image.source':
                'https://github.com/renovatebot/renovate',
            },
          },
        });
      const res = await getPkgReleases({
        datasource: id,
        depName: 'registry.company.com/node',
      });
      expect(res).toMatchSnapshot();
    });

    it('supports manifest lists', async () => {
      httpMock
        .scope('https://registry.company.com/v2')
        .get('/')
        .times(4)
        .reply(200)
        .get('/node/tags/list?n=10000')
        .reply(200, { tags: ['abc'] })
        .get('/node/manifests/abc')
        .reply(200, {
          schemaVersion: 2,
          mediaType: MediaType.manifestListV2,
          manifests: [{ digest: 'some-image-digest' }],
        })
        .get('/node/manifests/some-image-digest')
        .reply(200, {
          schemaVersion: 2,
          mediaType: MediaType.manifestV2,
          config: { digest: 'some-config-digest' },
        })
        .get('/node/blobs/some-config-digest')
        .reply(200, {
          config: {
            Labels: {
              'org.opencontainers.image.source':
                'https://github.com/renovatebot/renovate',
            },
          },
        });
      const res = await getPkgReleases({
        datasource: id,
        depName: 'registry.company.com/node',
      });
      expect(res).toMatchSnapshot();
    });

    it('ignores unsupported manifest', async () => {
      httpMock
        .scope('https://registry.company.com/v2')
        .get('/')
        .times(2)
        .reply(200)
        .get('/node/tags/list?n=10000')
        .reply(200, { tags: ['latest'] })
        .get('/node/manifests/latest')
        .reply(200, {
          schemaVersion: 2,
          mediaType: MediaType.manifestV1,
        });
      const res = await getPkgReleases({
        datasource: id,
        depName: 'registry.company.com/node',
      });
      expect(res).toMatchSnapshot();
    });

    it('ignores unsupported schema version', async () => {
      httpMock
        .scope('https://registry.company.com/v2')
        .get('/')
        .times(2)
        .reply(200)
        .get('/node/tags/list?n=10000')
        .reply(200, { tags: ['latest'] })
        .get('/node/manifests/latest')
        .reply(200, {});
      const res = await getPkgReleases({
        datasource: id,
        depName: 'registry.company.com/node',
      });
      expect(res).toMatchSnapshot();
    });

    it('supports redirect', async () => {
      httpMock
        .scope('https://registry.company.com/v2', {
          badheaders: ['authorization'],
        })
        .get('/')
        .times(3)
        .reply(401, '', {
          'www-authenticate': 'Basic realm="My Private Docker Registry Server"',
        });
      httpMock
        .scope('https://registry.company.com/v2', {
          reqheaders: {
            authorization: 'Basic c29tZS11c2VybmFtZTpzb21lLXBhc3N3b3Jk',
          },
        })
        .get('/node/tags/list?n=10000')
        .reply(200, { tags: ['latest'] })
        .get('/node/manifests/latest')
        .reply(200, {
          schemaVersion: 2,
          mediaType: MediaType.manifestV2,
          config: { digest: 'some-config-digest' },
        })
        .get('/node/blobs/some-config-digest')
        .reply(302, undefined, {
          location:
            'https://abc.s3.amazon.com/some-config-digest?X-Amz-Algorithm=xxxx',
        });
      httpMock
        .scope('https://abc.s3.amazon.com', { badheaders: ['authorization'] })
        .get('/some-config-digest')
        .query({ 'X-Amz-Algorithm': 'xxxx' })
        .reply(200, {
          config: {},
        });
      const res = await getPkgReleases({
        datasource: id,
        depName: 'registry.company.com/node',
      });
      expect(res).toMatchSnapshot();
    });
  });
});
