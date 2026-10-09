import numpy as np

from app.research_embedding import ResearchTextEmbedding


class Tokenizer:
    def num_special_tokens_to_add(self):
        return 2

    def encode(self, text, **kwargs):
        return list(range(int(text)))

    def decode(self, tokens, **kwargs):
        return " ".join(map(str, tokens))


class Model:
    tokenizer = Tokenizer()
    max_seq_length = 128

    def encode(self, texts, **kwargs):
        self.texts = texts
        return np.array([[1.0, float(len(text.split()))] for text in texts])


def test_passage_windows_preserve_tail_and_model_limit():
    embedding = ResearchTextEmbedding.__new__(ResearchTextEmbedding)
    embedding.model = Model()
    result = embedding.passage_embed(["400", "20"])
    windows = [list(map(int, text.split())) for text in embedding.model.texts]
    assert all(len(window) <= 126 for window in windows)
    assert set(range(400)) <= {token for window in windows for token in window}
    assert result.shape == (2, 2)
    np.testing.assert_allclose(np.linalg.norm(result, axis=1), [1.0, 1.0])


def test_query_prefix_is_applied_once():
    embedding = ResearchTextEmbedding.__new__(ResearchTextEmbedding)
    embedding.model = Model()
    embedding.query_prefix = "query: "
    embedding.query_embed(["irrigation"])
    assert embedding.model.texts == ["query: irrigation"]
