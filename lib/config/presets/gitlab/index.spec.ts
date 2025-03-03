import * as httpMock from '../../../../test/http-mock';
import { EXTERNAL_HOST_ERROR } from '../../../constants/error-messages';
import { PRESET_DEP_NOT_FOUND } from '../util';
import * as gitlab from '.';

const gitlabApiHost = 'https://gitlab.com';
const basePath = '/api/v4/projects/some%2Frepo/repository';

describe('config/presets/gitlab/index', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('getPreset()', () => {
    it('throws EXTERNAL_HOST_ERROR', async () => {
      httpMock.scope(gitlabApiHost).get(`${basePath}/branches`).reply(500);
      await expect(
        gitlab.getPreset({
          packageName: 'some/repo',
          presetName: 'non-default',
        })
      ).rejects.toThrow(EXTERNAL_HOST_ERROR);
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('throws if missing', async () => {
      httpMock
        .scope(gitlabApiHost)
        .get(`${basePath}/branches`)
        .twice()
        .reply(200, [])
        .get(`${basePath}/files/default.json/raw?ref=master`)
        .reply(404, null)
        .get(`${basePath}/files/renovate.json/raw?ref=master`)
        .reply(404, null);
      await expect(
        gitlab.getPreset({ packageName: 'some/repo' })
      ).rejects.toThrow(PRESET_DEP_NOT_FOUND);
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('should return the preset', async () => {
      httpMock
        .scope(gitlabApiHost)
        .get(`${basePath}/branches`)
        .reply(200, [
          {
            name: 'devel',
          },
          {
            name: 'master',
            default: true,
          },
        ])
        .get(`${basePath}/files/default.json/raw?ref=master`)
        .reply(200, { foo: 'bar' }, {});

      const content = await gitlab.getPreset({ packageName: 'some/repo' });
      expect(content).toEqual({ foo: 'bar' });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('should return the preset with a tag', async () => {
      httpMock
        .scope(gitlabApiHost)
        .get(`${basePath}/files/default.json/raw?ref=someTag`)
        .reply(200, { foo: 'bar' }, {});

      const content = await gitlab.getPreset({
        packageName: 'some/repo',
        packageTag: 'someTag',
      });
      expect(content).toEqual({ foo: 'bar' });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('should query custom paths', async () => {
      httpMock
        .scope(gitlabApiHost)
        .get(`${basePath}/branches`)
        .reply(200, [
          {
            name: 'devel',
          },
          {
            name: 'master',
            default: true,
          },
        ])
        .get(`${basePath}/files/path%2Fcustom.json/raw?ref=master`)
        .reply(200, { foo: 'bar' }, {});

      const content = await gitlab.getPreset({
        packageName: 'some/repo',
        presetPath: 'path',
        presetName: 'custom',
      });
      expect(content).toEqual({ foo: 'bar' });
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });

  describe('getPresetFromEndpoint()', () => {
    it('uses default endpoint', async () => {
      httpMock
        .scope(gitlabApiHost)
        .get(`${basePath}/branches`)
        .reply(200, [
          {
            name: 'devel',
            default: true,
          },
        ])
        .get(`${basePath}/files/some.json/raw?ref=devel`)
        .reply(200, { preset: { file: {} } });
      expect(
        await gitlab.getPresetFromEndpoint(
          'some/repo',
          'some/preset/file',
          undefined
        )
      ).toEqual({});
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('uses custom endpoint', async () => {
      httpMock
        .scope('https://gitlab.example.org')
        .get(`${basePath}/branches`)
        .reply(200, [
          {
            name: 'devel',
            default: true,
          },
        ])
        .get(`${basePath}/files/some.json/raw?ref=devel`)
        .reply(404);
      await expect(
        gitlab.getPresetFromEndpoint(
          'some/repo',
          'some/preset/file',
          undefined,
          'https://gitlab.example.org/api/v4'
        )
      ).rejects.toThrow(PRESET_DEP_NOT_FOUND);
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('uses default endpoint with a tag', async () => {
      httpMock
        .scope(gitlabApiHost)
        .get(`${basePath}/files/some.json/raw?ref=someTag`)
        .reply(200, { preset: { file: {} } });
      expect(
        await gitlab.getPresetFromEndpoint(
          'some/repo',
          'some/preset/file',
          undefined,
          'https://gitlab.com/api/v4',
          'someTag'
        )
      ).toEqual({});
      expect(httpMock.getTrace()).toMatchSnapshot();
    });

    it('uses custom endpoint with a tag', async () => {
      httpMock
        .scope('https://gitlab.example.org')
        .get(`${basePath}/files/some.json/raw?ref=someTag`)
        .reply(200, { preset: { file: {} } });
      expect(
        await gitlab.getPresetFromEndpoint(
          'some/repo',
          'some/preset/file',
          undefined,
          'https://gitlab.example.org/api/v4',
          'someTag'
        )
      ).toEqual({});
      expect(httpMock.getTrace()).toMatchSnapshot();
    });
  });
});
